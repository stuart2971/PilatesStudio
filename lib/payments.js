/**
 * Payments.
 *
 * One interface, two backends:
 *
 *   Stripe mode  — set STRIPE_SECRET_KEY in .env and checkout redirects to a
 *                  real Stripe Checkout page (subscription mode for plans,
 *                  one-off payment mode for drop-ins). Fulfilment happens in
 *                  the webhook, which is the only place Stripe guarantees.
 *
 *   Demo mode    — no key set. Checkout renders the studio's own card form and
 *                  approves it locally so the whole flow can be clicked through
 *                  end to end. Nothing is charged and no card data is stored;
 *                  the form keeps only the last four digits.
 *
 * Callers never branch on the mode — they call createPlanCheckout() /
 * createDropInCheckout() and follow the returned url.
 */

const crypto = require('crypto');
const store = require('./store');
const booking = require('./booking');
const { httpError } = require('./auth');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const API = 'https://api.stripe.com/v1';

const live = () => Boolean(STRIPE_KEY);

// ------------------------------------------------------------ stripe wire

/** Stripe takes form-encoded bodies with bracket notation for nesting. */
function encode(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encode(value, k, out);
    else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return out;
}

async function stripe(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + STRIPE_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encode(body).join('&'),
  });
  const json = await res.json();
  if (!res.ok) {
    const message = (json.error && json.error.message) || 'Payment provider error.';
    throw httpError(502, message);
  }
  return json;
}

// --------------------------------------------------------------- checkout

function record(fields) {
  return store.mutate((db) => {
    const payment = {
      id: store.id('pay'),
      status: 'pending',
      mode: live() ? 'stripe' : 'demo',
      createdAt: new Date().toISOString(),
      ...fields,
    };
    db.payments.push(payment);
    return payment;
  });
}

/** Start a recurring monthly membership. */
async function createPlanCheckout(user, planId, origin) {
  const db = store.read();
  const plan = db.plans.find((p) => p.id === planId);
  if (!plan) throw httpError(404, 'That plan does not exist.');

  const existing = booking.membership(user.id);
  if (existing && existing.plan.id === plan.id && !existing.cancelAtPeriodEnd) {
    throw httpError(400, `You are already on the ${plan.name} plan.`);
  }

  const payment = record({
    userId: user.id,
    kind: 'subscription',
    planId: plan.id,
    amount: plan.price,
    currency: db.studio.currency,
    description: `${plan.name} membership — $${plan.price}/month`,
  });

  if (!live()) {
    return { url: `/checkout.html?payment=${payment.id}`, paymentId: payment.id, mode: 'demo' };
  }

  const session = await stripe('/checkout/sessions', {
    mode: 'subscription',
    customer_email: user.email,
    client_reference_id: payment.id,
    success_url: `${origin}/account.html?welcome=${plan.id}`,
    cancel_url: `${origin}/memberships.html?cancelled=1`,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': db.studio.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': plan.price * 100,
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': `${plan.name} Membership`,
    'line_items[0][price_data][product_data][description]': plan.tagline,
    'metadata[paymentId]': payment.id,
    'subscription_data[metadata][paymentId]': payment.id,
  });

  store.mutate(() => {
    payment.providerId = session.id;
  });
  return { url: session.url, paymentId: payment.id, mode: 'stripe' };
}

/** Pay for a single class — no membership, or credits exhausted. */
async function createDropInCheckout(user, sessionId, origin) {
  const db = store.read();
  const klass = booking.getSession(sessionId);
  const decision = booking.evaluate(user, klass);
  if (!decision.allowed) throw httpError(400, decision.reason);
  if (decision.method !== 'pay') throw httpError(400, 'This class is already covered by your membership.');

  const payment = record({
    userId: user.id,
    kind: 'class',
    sessionId,
    amount: decision.price,
    currency: db.studio.currency,
    description: `${klass.className} — ${klass.date} at ${klass.time}`,
  });

  if (!live()) {
    return { url: `/checkout.html?payment=${payment.id}`, paymentId: payment.id, mode: 'demo' };
  }

  const session = await stripe('/checkout/sessions', {
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: payment.id,
    success_url: `${origin}/account.html?booked=1`,
    cancel_url: `${origin}/book.html?cancelled=1`,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': db.studio.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': decision.price * 100,
    'line_items[0][price_data][product_data][name]': klass.className,
    'line_items[0][price_data][product_data][description]': payment.description,
    'metadata[paymentId]': payment.id,
  });

  store.mutate(() => {
    payment.providerId = session.id;
  });
  return { url: session.url, paymentId: payment.id, mode: 'stripe' };
}

// -------------------------------------------------------------- fulfilment

/** Turn a successful payment into the thing the customer actually bought. */
function fulfil(payment) {
  if (payment.status === 'paid') return { alreadyDone: true };

  const user = store.read().users.find((u) => u.id === payment.userId);
  if (!user) throw httpError(404, 'Unknown customer on that payment.');

  store.mutate(() => {
    payment.status = 'paid';
    payment.paidAt = new Date().toISOString();
  });

  if (payment.kind === 'subscription') {
    const sub = startSubscription(user, payment);
    return { subscription: sub };
  }

  const bkg = booking.book(user, payment.sessionId, { paid: true, paymentId: payment.id });
  return { booking: bkg };
}

function startSubscription(user, payment) {
  return store.mutate((db) => {
    // A plan change ends the old membership immediately and carries nothing
    // over; credits already spent this cycle stay spent.
    for (const s of db.subscriptions) {
      if (s.userId === user.id && s.status === 'active') {
        s.status = 'cancelled';
        s.endedAt = new Date().toISOString();
        s.replacedBy = payment.planId;
      }
    }
    const now = new Date();
    const sub = {
      id: store.id('sub'),
      userId: user.id,
      planId: payment.planId,
      status: 'active',
      creditsUsed: 0,
      guestPassesUsed: 0,
      renewals: 0,
      cancelAtPeriodEnd: false,
      startedAt: now.toISOString(),
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: booking.addMonths(now).toISOString(),
      paymentId: payment.id,
      providerId: payment.providerId || null,
    };
    db.subscriptions.push(sub);
    return sub;
  });
}

/**
 * Demo-mode approval. Real card data never reaches this server in Stripe mode,
 * and even here only the last four digits are kept, purely so the receipt and
 * the account page have something to show.
 */
function approveDemo(paymentId, card = {}) {
  if (live()) throw httpError(400, 'Live payments are handled by Stripe.');
  const payment = store.read().payments.find((p) => p.id === paymentId);
  if (!payment) throw httpError(404, 'Unknown payment.');
  if (payment.status === 'paid') return { payment, result: { alreadyDone: true } };

  const number = String(card.number || '').replace(/\D/g, '');
  if (number.length < 12) throw httpError(400, 'Enter a full card number.');
  if (!/^\d{2}\s*\/\s*\d{2}$/.test(String(card.expiry || ''))) throw httpError(400, 'Expiry must be MM / YY.');
  if (!/^\d{3,4}$/.test(String(card.cvc || ''))) throw httpError(400, 'Check the security code.');

  store.mutate(() => {
    payment.card = { last4: number.slice(-4), brand: brandOf(number) };
    payment.name = String(card.name || '').slice(0, 80);
  });

  const result = fulfil(payment);
  return { payment, result };
}

function brandOf(number) {
  if (/^4/.test(number)) return 'Visa';
  if (/^5[1-5]/.test(number)) return 'Mastercard';
  if (/^3[47]/.test(number)) return 'Amex';
  return 'Card';
}

/** Stop a recurring membership at the end of the paid period. */
async function cancelSubscription(user) {
  const m = booking.membership(user.id);
  if (!m) throw httpError(400, 'You do not have an active membership.');

  const sub = store.read().subscriptions.find((s) => s.id === m.subscriptionId);
  if (live() && sub.providerSubscriptionId) {
    await stripe('/subscriptions/' + sub.providerSubscriptionId, { cancel_at_period_end: true });
  }
  store.mutate(() => {
    sub.cancelAtPeriodEnd = true;
    sub.cancelRequestedAt = new Date().toISOString();
  });
  return booking.membershipView(user.id);
}

async function resumeSubscription(user) {
  const m = booking.membership(user.id);
  if (!m) throw httpError(400, 'You do not have an active membership.');
  const sub = store.read().subscriptions.find((s) => s.id === m.subscriptionId);
  if (live() && sub.providerSubscriptionId) {
    await stripe('/subscriptions/' + sub.providerSubscriptionId, { cancel_at_period_end: false });
  }
  store.mutate(() => {
    sub.cancelAtPeriodEnd = false;
    delete sub.cancelRequestedAt;
  });
  return booking.membershipView(user.id);
}

// --------------------------------------------------------------- webhooks

/**
 * Stripe signs every webhook. Verify before trusting a word of it, otherwise
 * anyone who finds the URL can hand out free memberships.
 */
function verifySignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return true; // not configured — dev only
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('='))
  );
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // replay guard
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handleWebhook(rawBody, signature) {
  if (!verifySignature(rawBody, signature)) throw httpError(400, 'Bad signature.');
  const event = JSON.parse(rawBody);
  const object = event.data && event.data.object;
  const db = store.read();

  if (event.type === 'checkout.session.completed') {
    const paymentId = (object.metadata && object.metadata.paymentId) || object.client_reference_id;
    const payment = db.payments.find((p) => p.id === paymentId);
    if (payment) {
      store.mutate(() => {
        payment.providerSubscriptionId = object.subscription || null;
        payment.providerPaymentIntent = object.payment_intent || null;
      });
      const result = fulfil(payment);
      if (result.subscription && object.subscription) {
        store.mutate(() => {
          result.subscription.providerSubscriptionId = object.subscription;
        });
      }
    }
  }

  if (event.type === 'invoice.paid' && object.subscription) {
    // Monthly renewal: reset the allowance for the new period.
    const sub = db.subscriptions.find((s) => s.providerSubscriptionId === object.subscription);
    if (sub) {
      store.mutate(() => {
        sub.creditsUsed = 0;
        sub.guestPassesUsed = 0;
        sub.renewals = (sub.renewals || 0) + 1;
        sub.currentPeriodStart = new Date().toISOString();
        sub.currentPeriodEnd = booking.addMonths(new Date()).toISOString();
      });
    }
  }

  if (event.type === 'customer.subscription.deleted' && object.id) {
    const sub = db.subscriptions.find((s) => s.providerSubscriptionId === object.id);
    if (sub) {
      store.mutate(() => {
        sub.status = 'cancelled';
        sub.endedAt = new Date().toISOString();
      });
    }
  }

  return { received: true };
}

module.exports = {
  live,
  createPlanCheckout,
  createDropInCheckout,
  approveDemo,
  cancelSubscription,
  resumeSubscription,
  handleWebhook,
};

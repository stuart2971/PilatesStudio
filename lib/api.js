/**
 * JSON API.
 *
 * Every route returns { status, json } or throws an error carrying .status.
 * The browser is never trusted: eligibility, credits, capacity and pricing are
 * all recomputed here on each request.
 */

const store = require('./store');
const auth = require('./auth');
const booking = require('./booking');
const payments = require('./payments');

const { httpError } = auth;

function requireUser(ctx) {
  const user = auth.currentUser(ctx.req);
  if (!user) throw httpError(401, 'Please log in to continue.');
  return user;
}

/** Everything the account page and header need in one round trip. */
function meView(user) {
  return {
    user: auth.publicUser(user),
    membership: booking.membershipView(user.id),
    bookings: booking.bookingsFor(user.id),
    payments: store
      .read()
      .payments.filter((p) => p.userId === user.id && p.status === 'paid')
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        amount: p.amount,
        currency: p.currency,
        description: p.description,
        paidAt: p.paidAt,
        card: p.card || null,
      }))
      .sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1)),
  };
}

const routes = {
  'GET /api/config': () => {
    const db = store.read();
    return {
      status: 200,
      json: {
        studio: db.studio,
        plans: db.plans,
        dropIn: db.dropIn,
        classTypes: db.classTypes,
        instructors: db.instructors,
        paymentMode: payments.live() ? 'stripe' : 'demo',
      },
    };
  },

  'GET /api/sessions': (ctx) => {
    const user = auth.currentUser(ctx.req);
    const sessions = booking.listSessions({ from: ctx.query.from, to: ctx.query.to });
    const filtered = ctx.query.classType
      ? sessions.filter((s) => s.classTypeId === ctx.query.classType)
      : sessions;

    // Attach a per-user verdict so the UI can label each slot honestly
    // (bookable / needs payment / outside your window / already booked).
    const withVerdict = filtered.map((s) => {
      if (!user) return { ...s, verdict: null };
      const v = booking.evaluate(user, s);
      return {
        ...s,
        verdict: {
          allowed: v.allowed,
          method: v.method || null,
          price: v.price || 0,
          reason: v.reason || null,
          code: v.code || null,
          waitlist: !!v.waitlist,
        },
      };
    });

    return {
      status: 200,
      json: {
        sessions: withVerdict,
        membership: user ? booking.membershipView(user.id) : null,
      },
    };
  },

  'POST /api/auth/signup': (ctx) => {
    const user = auth.signup(ctx.body);
    return {
      status: 201,
      json: meView(user),
      headers: { 'Set-Cookie': auth.sessionCookie(user.id) },
    };
  },

  'POST /api/auth/login': (ctx) => {
    const user = auth.login(ctx.body);
    return {
      status: 200,
      json: meView(user),
      headers: { 'Set-Cookie': auth.sessionCookie(user.id) },
    };
  },

  'POST /api/auth/logout': () => ({
    status: 200,
    json: { ok: true },
    headers: { 'Set-Cookie': auth.clearCookie() },
  }),

  'GET /api/me': (ctx) => {
    const user = auth.currentUser(ctx.req);
    if (!user) return { status: 200, json: { user: null, membership: null, bookings: [] } };
    return { status: 200, json: meView(user) };
  },

  'POST /api/me': (ctx) => {
    const user = requireUser(ctx);
    store.mutate(() => {
      if (ctx.body.name) user.name = String(ctx.body.name).trim().slice(0, 80);
      if (ctx.body.phone !== undefined) user.phone = String(ctx.body.phone).trim().slice(0, 40);
    });
    return { status: 200, json: meView(user) };
  },

  /** What would happen if I booked this? Used by the booking wizard. */
  'GET /api/bookings/preview': (ctx) => {
    const user = requireUser(ctx);
    const session = booking.getSession(ctx.query.session);
    if (!session) throw httpError(404, 'That class is not on the schedule.');
    const verdict = booking.evaluate(user, session);
    return { status: 200, json: { session, verdict, membership: booking.membershipView(user.id) } };
  },

  'POST /api/bookings': (ctx) => {
    const user = requireUser(ctx);
    const bkg = booking.book(user, ctx.body.sessionId);
    return { status: 201, json: { booking: bkg, ...meView(user) } };
  },

  'POST /api/bookings/cancel': (ctx) => {
    const user = requireUser(ctx);
    const result = booking.cancel(user, ctx.body.bookingId);
    return { status: 200, json: { ...result, ...meView(user) } };
  },

  'POST /api/checkout/plan': async (ctx) => {
    const user = requireUser(ctx);
    const checkout = await payments.createPlanCheckout(user, ctx.body.planId, ctx.origin);
    return { status: 200, json: checkout };
  },

  'POST /api/checkout/class': async (ctx) => {
    const user = requireUser(ctx);
    const checkout = await payments.createDropInCheckout(user, ctx.body.sessionId, ctx.origin);
    return { status: 200, json: checkout };
  },

  'GET /api/checkout/payment': (ctx) => {
    const user = requireUser(ctx);
    const payment = store.read().payments.find((p) => p.id === ctx.query.id && p.userId === user.id);
    if (!payment) throw httpError(404, 'Unknown payment.');
    const session = payment.sessionId ? booking.getSession(payment.sessionId) : null;
    const plan = payment.planId ? booking.planById(payment.planId) : null;
    return {
      status: 200,
      json: {
        payment: {
          id: payment.id,
          kind: payment.kind,
          amount: payment.amount,
          currency: payment.currency,
          description: payment.description,
          status: payment.status,
        },
        session,
        plan,
      },
    };
  },

  'POST /api/checkout/confirm': (ctx) => {
    const user = requireUser(ctx);
    const payment = store
      .read()
      .payments.find((p) => p.id === ctx.body.paymentId && p.userId === user.id);
    if (!payment) throw httpError(404, 'Unknown payment.');
    const { result } = payments.approveDemo(payment.id, ctx.body.card || {});
    return { status: 200, json: { result, ...meView(user) } };
  },

  'POST /api/membership/cancel': async (ctx) => {
    const user = requireUser(ctx);
    await payments.cancelSubscription(user);
    return { status: 200, json: meView(user) };
  },

  'POST /api/membership/resume': async (ctx) => {
    const user = requireUser(ctx);
    await payments.resumeSubscription(user);
    return { status: 200, json: meView(user) };
  },

  'POST /api/webhooks/stripe': (ctx) => ({
    status: 200,
    json: payments.handleWebhook(ctx.raw, ctx.req.headers['stripe-signature']),
  }),

  'POST /api/contact': (ctx) => {
    const { name, email, message } = ctx.body;
    if (!name || !email || !message) throw httpError(400, 'Name, email and a message please.');
    store.mutate((db) => {
      db.messages.push({
        id: store.id('msg'),
        name: String(name).slice(0, 80),
        email: String(email).slice(0, 120),
        phone: String(ctx.body.phone || '').slice(0, 40),
        message: String(message).slice(0, 4000),
        at: new Date().toISOString(),
      });
    });
    return { status: 200, json: { ok: true } };
  },
};

async function handle(ctx) {
  const handler = routes[`${ctx.method} ${ctx.pathname}`];
  if (!handler) return null;
  return await handler(ctx);
}

module.exports = { handle };

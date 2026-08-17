/* ==========================================================================
   Static mode — the booking engine, in the browser.

   GitHub Pages (and any other static host) serves files but runs no Node
   process, so there is nothing to answer /api/*. This adapter implements the
   same endpoints against localStorage, enforcing the same rules: booking
   windows per tier, monthly class credits, priority waitlists, credit refunds
   on early cancellation and the demo card flow.

   It activates only when a real API is not reachable — run `node server.js`
   and this file stays dormant, with every request going to the server.

   Honest limits of this mode, all consequences of having no server:
     · data lives in this browser only, and clearing site data resets it;
     · accounts are local, so "log in" cannot be verified against anything;
     · no card is charged, and Stripe is never contacted.
   Treat it as a working demonstration of the product, not as a backend.
   ========================================================================== */

const StaticAPI = (() => {
  const KEY = 'corePilates.v1';
  const DAY_MS = 864e5;

  let catalogue = null;
  let enabled = false;

  // -------------------------------------------------------------- storage

  function blank() {
    return { users: [], subscriptions: [], bookings: [], payments: [], messages: [], session: null };
  }

  function load() {
    try {
      return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      return blank();
    }
  }

  function save(db) {
    localStorage.setItem(KEY, JSON.stringify(db));
  }

  const uid = (p) =>
    p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  function fail(status, message) {
    const err = new Error(message);
    err.status = status;
    throw err;
  }

  // ---------------------------------------------------------------- dates

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function sessionStart(date, time) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }

  function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  }

  function addMonths(date, n = 1) {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d;
  }

  // ------------------------------------------------------------- sessions

  const sessionId = (classTypeId, date, time) => `${classTypeId}_${date}_${time.replace(':', '')}`;

  function hydrate(db, slot, date) {
    const id = sessionId(slot.classTypeId, date, slot.time);
    const classType = catalogue.classTypes.find((c) => c.id === slot.classTypeId);
    const instructor = catalogue.instructors.find((i) => i.id === slot.instructorId);
    const live = db.bookings.filter((b) => b.sessionId === id && b.status !== 'cancelled');
    const booked = live.filter((b) => b.status === 'confirmed').length;

    return {
      id,
      date,
      time: slot.time,
      startsAt: sessionStart(date, slot.time).toISOString(),
      classTypeId: slot.classTypeId,
      className: classType ? classType.name : slot.classTypeId,
      duration: classType ? classType.duration : 50,
      level: classType ? classType.level : 'All Levels',
      instructorId: slot.instructorId,
      instructor: instructor ? instructor.name : '',
      capacity: slot.capacity,
      booked,
      spotsLeft: Math.max(0, slot.capacity - booked),
      waitlisted: live.filter((b) => b.status === 'waitlisted').length,
      full: booked >= slot.capacity,
    };
  }

  function listSessions(db) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = addDays(today, catalogue.studio.scheduleHorizonDays);
    const now = new Date();
    const out = [];

    for (let d = new Date(today); d <= limit; d = addDays(d, 1)) {
      const key = dateKey(d);
      for (const slot of catalogue.scheduleTemplate) {
        if (slot.day !== d.getDay()) continue;
        if (sessionStart(key, slot.time) <= now) continue;
        out.push(hydrate(db, slot, key));
      }
    }
    out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
    return out;
  }

  function getSession(db, id) {
    const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/.exec(String(id || ''));
    if (!m) return null;
    const [, classTypeId, date, hh, mm] = m;
    const slot = catalogue.scheduleTemplate.find(
      (s) =>
        s.classTypeId === classTypeId &&
        s.time === `${hh}:${mm}` &&
        s.day === sessionStart(date, '00:00').getDay()
    );
    return slot ? hydrate(db, slot, date) : null;
  }

  // ----------------------------------------------------------- membership

  const planById = (id) =>
    id === 'dropin' ? catalogue.dropIn : catalogue.plans.find((p) => p.id === id) || null;

  function membership(db, userId) {
    const sub = db.subscriptions.find((s) => s.userId === userId && s.status === 'active');
    if (!sub) return null;

    if (new Date(sub.currentPeriodEnd).getTime() <= Date.now()) {
      if (sub.cancelAtPeriodEnd) {
        sub.status = 'cancelled';
        sub.endedAt = sub.currentPeriodEnd;
        save(db);
        return null;
      }
      while (new Date(sub.currentPeriodEnd).getTime() <= Date.now()) {
        sub.currentPeriodStart = sub.currentPeriodEnd;
        sub.currentPeriodEnd = addMonths(new Date(sub.currentPeriodEnd)).toISOString();
        sub.renewals = (sub.renewals || 0) + 1;
      }
      sub.creditsUsed = 0;
      sub.guestPassesUsed = 0;
      save(db);
    }

    const plan = planById(sub.planId);
    const unlimited = plan.monthlyCredits === null;
    return {
      subscriptionId: sub.id,
      plan,
      status: sub.status,
      unlimited,
      creditsTotal: plan.monthlyCredits,
      creditsUsed: sub.creditsUsed,
      creditsLeft: unlimited ? null : Math.max(0, plan.monthlyCredits - sub.creditsUsed),
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      periodStartDate: dateKey(new Date(sub.currentPeriodStart)),
      periodEndDate: dateKey(new Date(sub.currentPeriodEnd)),
      cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
      guestPassesLeft: Math.max(0, plan.guestPassesPerMonth - (sub.guestPassesUsed || 0)),
    };
  }

  // ---------------------------------------------------------- eligibility

  const deny = (reason, code = 'blocked') => ({ allowed: false, reason, code });

  function evaluate(db, user, session) {
    if (!session) return deny('That class is no longer on the schedule.', 'gone');

    const existing = db.bookings.find(
      (b) => b.userId === user.id && b.sessionId === session.id && b.status !== 'cancelled'
    );
    if (existing) {
      return existing.status === 'waitlisted'
        ? deny('You are already on the waitlist for this class.', 'waitlisted')
        : deny('You are already booked into this class.', 'booked');
    }

    const starts = new Date(session.startsAt).getTime();
    if (starts <= Date.now()) return deny('That class has already started.', 'started');

    const m = membership(db, user.id);
    const plan = m ? m.plan : catalogue.dropIn;

    if (starts > Date.now() + plan.bookingWindowDays * DAY_MS) {
      const label = m ? `your ${plan.name} membership lets you` : 'without a membership you can';
      return deny(
        `Opens closer to the date — ${label} book ${plan.bookingWindowDays} days ahead. ` +
          (m && plan.id !== 'unlimited' ? 'Upgrade for a longer booking window.' : ''),
        'window'
      );
    }

    const clash = db.bookings.find((b) => {
      if (b.userId !== user.id || b.status !== 'confirmed') return false;
      const other = getSession(db, b.sessionId);
      if (!other) return false;
      return Math.abs(new Date(other.startsAt).getTime() - starts) < other.duration * 60000;
    });
    if (clash) return deny('That overlaps a class you have already booked.', 'clash');

    if (m && m.unlimited) return { allowed: true, method: 'included', price: 0, waitlist: session.full, plan };
    if (m && m.creditsLeft > 0) return { allowed: true, method: 'credit', price: 0, waitlist: session.full, plan };

    if (session.full) {
      return deny(
        m
          ? `This class is full. Waitlist spots are held for members with classes remaining — ` +
              `you have used all ${plan.monthlyCredits} this cycle.`
          : 'This class is full. Waitlist spots are held for members — a membership starts at $79/month.',
        'full'
      );
    }

    return {
      allowed: true,
      method: 'pay',
      price: m ? plan.dropInRate : catalogue.dropIn.price,
      waitlist: false,
      plan,
      note: m
        ? `You have used all ${plan.monthlyCredits} classes this cycle. Member rate applies.`
        : 'Single class, no membership needed.',
    };
  }

  // --------------------------------------------------------------- actions

  function book(db, user, id, { paid = false, paymentId = null } = {}) {
    const session = getSession(db, id);
    const decision = evaluate(db, user, session);
    if (!decision.allowed) fail(400, decision.reason);
    if (decision.method === 'pay' && !paid) fail(402, 'Payment required for this class.');

    const confirmed = db.bookings.filter((b) => b.sessionId === id && b.status === 'confirmed');
    const full = confirmed.length >= session.capacity;
    const m = membership(db, user.id);

    const booking = {
      id: uid('bkg'),
      userId: user.id,
      sessionId: id,
      classTypeId: session.classTypeId,
      className: session.className,
      startsAt: session.startsAt,
      date: session.date,
      time: session.time,
      status: full ? 'waitlisted' : 'confirmed',
      method: decision.method,
      priority: !!(m && m.plan.priorityWaitlist),
      amountPaid: decision.method === 'pay' ? decision.price : 0,
      paymentId,
      creditUsed: false,
      createdAt: new Date().toISOString(),
    };

    if (!full && decision.method === 'credit') {
      const sub = db.subscriptions.find((s) => s.id === m.subscriptionId);
      sub.creditsUsed += 1;
      booking.creditUsed = true;
    }

    db.bookings.push(booking);
    save(db);
    return booking;
  }

  function cancel(db, user, bookingId) {
    const booking = db.bookings.find((b) => b.id === bookingId && b.userId === user.id);
    if (!booking) fail(404, 'We could not find that booking.');
    if (booking.status === 'cancelled') fail(400, 'That booking is already cancelled.');

    const m = membership(db, user.id);
    const windowHours = (m ? m.plan.lateCancelHours : catalogue.dropIn.lateCancelHours) || 12;
    const hoursOut = (new Date(booking.startsAt).getTime() - Date.now()) / 3600000;
    const late = hoursOut < windowHours;

    booking.status = 'cancelled';
    booking.cancelledAt = new Date().toISOString();
    booking.lateCancel = late && hoursOut > -1;

    let refundedCredit = false;
    if (booking.creditUsed && !late) {
      const sub = db.subscriptions.find((s) => s.userId === user.id && s.status === 'active');
      if (sub) {
        sub.creditsUsed = Math.max(0, sub.creditsUsed - 1);
        refundedCredit = true;
        booking.creditUsed = false;
      }
    }

    promote(db, booking.sessionId);
    save(db);
    return { booking, refundedCredit, late: booking.lateCancel, windowHours };
  }

  function promote(db, id) {
    const session = getSession(db, id);
    if (!session) return;
    const confirmed = db.bookings.filter((b) => b.sessionId === id && b.status === 'confirmed');
    if (confirmed.length >= session.capacity) return;

    const next = db.bookings
      .filter((b) => b.sessionId === id && b.status === 'waitlisted')
      .sort((a, b) => (a.priority !== b.priority ? (a.priority ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))[0];
    if (!next) return;

    next.status = 'confirmed';
    next.promotedAt = new Date().toISOString();
    if (next.method === 'credit') {
      const sub = db.subscriptions.find((s) => s.userId === next.userId && s.status === 'active');
      if (sub) {
        sub.creditsUsed += 1;
        next.creditUsed = true;
      }
    }
  }

  function bookingsFor(db, userId) {
    return db.bookings
      .filter((b) => b.userId === userId)
      .map((b) => {
        const session = getSession(db, b.sessionId);
        return {
          ...b,
          instructor: session ? session.instructor : '',
          duration: session ? session.duration : null,
          past: new Date(b.startsAt).getTime() < Date.now(),
        };
      })
      .sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1));
  }

  // ----------------------------------------------------------------- auth

  async function hash(password, salt) {
    const bytes = new TextEncoder().encode(salt + ':' + password);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const currentUser = (db) => db.users.find((u) => u.id === db.session) || null;

  function requireUser(db) {
    const user = currentUser(db);
    if (!user) fail(401, 'Please log in to continue.');
    return user;
  }

  function meView(db, user) {
    return {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone || '' },
      membership: membership(db, user.id),
      bookings: bookingsFor(db, user.id),
      payments: db.payments
        .filter((p) => p.userId === user.id && p.status === 'paid')
        .sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1)),
    };
  }

  // ------------------------------------------------------------- payments

  function createPayment(db, fields) {
    const payment = {
      id: uid('pay'),
      status: 'pending',
      mode: 'demo',
      createdAt: new Date().toISOString(),
      currency: catalogue.studio.currency,
      ...fields,
    };
    db.payments.push(payment);
    save(db);
    return payment;
  }

  function startSubscription(db, user, payment) {
    for (const s of db.subscriptions) {
      if (s.userId === user.id && s.status === 'active') {
        s.status = 'cancelled';
        s.endedAt = new Date().toISOString();
      }
    }
    const now = new Date();
    const sub = {
      id: uid('sub'),
      userId: user.id,
      planId: payment.planId,
      status: 'active',
      creditsUsed: 0,
      guestPassesUsed: 0,
      renewals: 0,
      cancelAtPeriodEnd: false,
      startedAt: now.toISOString(),
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: addMonths(now).toISOString(),
      paymentId: payment.id,
    };
    db.subscriptions.push(sub);
    return sub;
  }

  const brandOf = (n) =>
    /^4/.test(n) ? 'Visa' : /^5[1-5]/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : 'Card';

  // --------------------------------------------------------------- router

  const routes = {
    'GET /api/config': () => ({
      studio: catalogue.studio,
      plans: catalogue.plans,
      dropIn: catalogue.dropIn,
      classTypes: catalogue.classTypes,
      instructors: catalogue.instructors,
      paymentMode: 'demo',
    }),

    'GET /api/sessions': (db, { query }) => {
      const user = currentUser(db);
      let sessions = listSessions(db);
      if (query.classType) sessions = sessions.filter((s) => s.classTypeId === query.classType);
      return {
        sessions: sessions.map((s) => {
          if (!user) return { ...s, verdict: null };
          const v = evaluate(db, user, s);
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
        }),
        membership: user ? membership(db, user.id) : null,
      };
    },

    'POST /api/auth/signup': async (db, { body }) => {
      const email = String(body.email || '').trim().toLowerCase();
      if (!String(body.name || '').trim()) fail(400, 'Please tell us your name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'That email does not look right.');
      if (String(body.password || '').length < 8) fail(400, 'Passwords need at least 8 characters.');
      if (db.users.some((u) => u.email === email))
        fail(409, 'An account already uses that email. Try logging in.');

      const salt = uid('s');
      const user = {
        id: uid('usr'),
        name: String(body.name).trim(),
        email,
        phone: String(body.phone || '').trim(),
        salt,
        password: await hash(body.password, salt),
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      db.session = user.id;
      save(db);
      return meView(db, user);
    },

    'POST /api/auth/login': async (db, { body }) => {
      const email = String(body.email || '').trim().toLowerCase();
      const user = db.users.find((u) => u.email === email);
      if (!user || (await hash(body.password, user.salt)) !== user.password) {
        fail(401, 'Email or password is incorrect.');
      }
      db.session = user.id;
      save(db);
      return meView(db, user);
    },

    'POST /api/auth/logout': (db) => {
      db.session = null;
      save(db);
      return { ok: true };
    },

    'GET /api/me': (db) => {
      const user = currentUser(db);
      return user ? meView(db, user) : { user: null, membership: null, bookings: [], payments: [] };
    },

    'POST /api/me': (db, { body }) => {
      const user = requireUser(db);
      if (body.name) user.name = String(body.name).trim().slice(0, 80);
      if (body.phone !== undefined) user.phone = String(body.phone).trim().slice(0, 40);
      save(db);
      return meView(db, user);
    },

    'GET /api/bookings/preview': (db, { query }) => {
      const user = requireUser(db);
      const session = getSession(db, query.session);
      if (!session) fail(404, 'That class is not on the schedule.');
      return { session, verdict: evaluate(db, user, session), membership: membership(db, user.id) };
    },

    'POST /api/bookings': (db, { body }) => {
      const user = requireUser(db);
      return { booking: book(db, user, body.sessionId), ...meView(db, user) };
    },

    'POST /api/bookings/cancel': (db, { body }) => {
      const user = requireUser(db);
      return { ...cancel(db, user, body.bookingId), ...meView(db, user) };
    },

    'POST /api/checkout/plan': (db, { body }) => {
      const user = requireUser(db);
      const plan = catalogue.plans.find((p) => p.id === body.planId);
      if (!plan) fail(404, 'That plan does not exist.');
      const existing = membership(db, user.id);
      if (existing && existing.plan.id === plan.id && !existing.cancelAtPeriodEnd)
        fail(400, `You are already on the ${plan.name} plan.`);

      const payment = createPayment(db, {
        userId: user.id,
        kind: 'subscription',
        planId: plan.id,
        amount: plan.price,
        description: `${plan.name} membership — $${plan.price}/month`,
      });
      return { url: `checkout.html?payment=${payment.id}`, paymentId: payment.id, mode: 'demo' };
    },

    'POST /api/checkout/class': (db, { body }) => {
      const user = requireUser(db);
      const session = getSession(db, body.sessionId);
      const decision = evaluate(db, user, session);
      if (!decision.allowed) fail(400, decision.reason);
      if (decision.method !== 'pay') fail(400, 'This class is already covered by your membership.');

      const payment = createPayment(db, {
        userId: user.id,
        kind: 'class',
        sessionId: body.sessionId,
        amount: decision.price,
        description: `${session.className} — ${session.date} at ${session.time}`,
      });
      return { url: `checkout.html?payment=${payment.id}`, paymentId: payment.id, mode: 'demo' };
    },

    'GET /api/checkout/payment': (db, { query }) => {
      const user = requireUser(db);
      const payment = db.payments.find((p) => p.id === query.id && p.userId === user.id);
      if (!payment) fail(404, 'Unknown payment.');
      return {
        payment,
        session: payment.sessionId ? getSession(db, payment.sessionId) : null,
        plan: payment.planId ? planById(payment.planId) : null,
      };
    },

    'POST /api/checkout/confirm': (db, { body }) => {
      const user = requireUser(db);
      const payment = db.payments.find((p) => p.id === body.paymentId && p.userId === user.id);
      if (!payment) fail(404, 'Unknown payment.');
      if (payment.status === 'paid') return { result: { alreadyDone: true }, ...meView(db, user) };

      const card = body.card || {};
      const number = String(card.number || '').replace(/\D/g, '');
      if (number.length < 12) fail(400, 'Enter a full card number.');
      if (!/^\d{2}\s*\/\s*\d{2}$/.test(String(card.expiry || ''))) fail(400, 'Expiry must be MM / YY.');
      if (!/^\d{3,4}$/.test(String(card.cvc || ''))) fail(400, 'Check the security code.');

      payment.card = { last4: number.slice(-4), brand: brandOf(number) };
      payment.status = 'paid';
      payment.paidAt = new Date().toISOString();

      let result;
      if (payment.kind === 'subscription') {
        result = { subscription: startSubscription(db, user, payment) };
        save(db);
      } else {
        result = { booking: book(db, user, payment.sessionId, { paid: true, paymentId: payment.id }) };
      }
      save(db);
      return { result, ...meView(db, user) };
    },

    'POST /api/membership/cancel': (db) => {
      const user = requireUser(db);
      const m = membership(db, user.id);
      if (!m) fail(400, 'You do not have an active membership.');
      db.subscriptions.find((s) => s.id === m.subscriptionId).cancelAtPeriodEnd = true;
      save(db);
      return meView(db, user);
    },

    'POST /api/membership/resume': (db) => {
      const user = requireUser(db);
      const m = membership(db, user.id);
      if (!m) fail(400, 'You do not have an active membership.');
      db.subscriptions.find((s) => s.id === m.subscriptionId).cancelAtPeriodEnd = false;
      save(db);
      return meView(db, user);
    },

    'POST /api/contact': (db, { body }) => {
      if (!body.name || !body.email || !body.message) fail(400, 'Name, email and a message please.');
      db.messages.push({ id: uid('msg'), ...body, at: new Date().toISOString() });
      save(db);
      return { ok: true };
    },
  };

  // --------------------------------------------------------------- public

  async function ready() {
    if (catalogue) return;
    const res = await fetch(new URL('assets/data/catalogue.json', document.baseURI));
    catalogue = await res.json();
  }

  async function handle(path, options = {}) {
    await ready();
    const url = new URL(path, location.origin + '/');
    const method = (options.method || 'GET').toUpperCase();
    const key = `${method} ${url.pathname.replace(/^.*(\/api\/.*)$/, '$1')}`;
    const route = routes[key];
    if (!route) fail(404, 'No such endpoint.');

    const db = load();
    return await route(db, {
      body: options.body || {},
      query: Object.fromEntries(url.searchParams),
    });
  }

  return {
    handle,
    get enabled() {
      return enabled;
    },
    enable() {
      if (enabled) return;
      enabled = true;
      console.info(
        '[Core Pilates] No booking server reachable — running the in-browser demo. ' +
          'Bookings and memberships are stored locally in this browser only.'
      );
      document.documentElement.classList.add('static-mode');
      if (typeof App !== 'undefined' && App.showDemoBanner) App.showDemoBanner();
    },
    reset() {
      localStorage.removeItem(KEY);
    },
  };
})();

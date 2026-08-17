/**
 * The booking engine.
 *
 * Two ideas do most of the work here:
 *
 *  1. Sessions are *derived*, not stored. The weekly grid in lib/seed.js is
 *     projected forward on demand, so the schedule never needs backfilling and
 *     a timetable change applies to every future date at once. Only the things
 *     a customer actually did — bookings, payments — are persisted.
 *
 *  2. Every privilege lives on the plan record, and every rule is checked here,
 *     server-side. The browser decides what to *show*; it never decides what a
 *     member is allowed to do.
 */

const store = require('./store');
const { httpError } = require('./auth');

const DAY_MS = 864e5;

// ----------------------------------------------------------- date helpers

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A naive studio-local Date for "2026-08-20" + "18:45". */
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

// --------------------------------------------------------------- sessions

function sessionId(classTypeId, date, time) {
  return `${classTypeId}_${date}_${time.replace(':', '')}`;
}

/**
 * Every session between two date keys, newest privileges applied by the caller.
 * Past sessions and sessions beyond the schedule horizon are excluded.
 */
function listSessions({ from, to } = {}) {
  const db = store.read();
  const horizon = db.studio.scheduleHorizonDays;
  const first = from ? sessionStart(from, '00:00') : startOfToday();
  const last = to ? sessionStart(to, '23:59') : addDays(startOfToday(), horizon);
  const limit = addDays(startOfToday(), horizon);
  const now = new Date();

  const out = [];
  for (let d = new Date(first); d <= last && d <= limit; d = addDays(d, 1)) {
    const key = dateKey(d);
    const weekday = d.getDay();
    for (const slot of db.scheduleTemplate) {
      if (slot.day !== weekday) continue;
      const starts = sessionStart(key, slot.time);
      if (starts <= now) continue; // never offer a class that has already begun
      out.push(hydrate(db, slot, key));
    }
  }
  out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
  return out;
}

function hydrate(db, slot, date) {
  const id = sessionId(slot.classTypeId, date, slot.time);
  const classType = db.classTypes.find((c) => c.id === slot.classTypeId);
  const instructor = db.instructors.find((i) => i.id === slot.instructorId);
  const live = db.bookings.filter((b) => b.sessionId === id && b.status !== 'cancelled');
  const confirmed = live.filter((b) => b.status === 'confirmed').length;
  const waitlisted = live.filter((b) => b.status === 'waitlisted').length;
  const starts = sessionStart(date, slot.time);

  return {
    id,
    date,
    time: slot.time,
    startsAt: starts.toISOString(),
    classTypeId: slot.classTypeId,
    className: classType ? classType.name : slot.classTypeId,
    duration: classType ? classType.duration : 50,
    level: classType ? classType.level : 'All Levels',
    instructorId: slot.instructorId,
    instructor: instructor ? instructor.name : '',
    capacity: slot.capacity,
    booked: confirmed,
    spotsLeft: Math.max(0, slot.capacity - confirmed),
    waitlisted,
    full: confirmed >= slot.capacity,
  };
}

function getSession(id) {
  const db = store.read();
  const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/.exec(String(id || ''));
  if (!m) return null;
  const [, classTypeId, date, hh, mm] = m;
  const slot = db.scheduleTemplate.find(
    (s) =>
      s.classTypeId === classTypeId &&
      s.time === `${hh}:${mm}` &&
      s.day === sessionStart(date, '00:00').getDay()
  );
  if (!slot) return null;
  return hydrate(db, slot, date);
}

// ------------------------------------------------------------ memberships

function planById(id) {
  const db = store.read();
  if (id === 'dropin') return db.dropIn;
  return db.plans.find((p) => p.id === id) || null;
}

/**
 * The member's live entitlement. Billing periods roll forward lazily: if the
 * period has lapsed we advance it and reset the credit counter, which is what a
 * monthly recurring membership does on renewal.
 */
function membership(userId) {
  const db = store.read();
  const sub = db.subscriptions.find((s) => s.userId === userId && s.status === 'active');
  if (!sub) return null;

  const now = Date.now();
  if (new Date(sub.currentPeriodEnd).getTime() <= now) {
    if (sub.cancelAtPeriodEnd) {
      store.mutate(() => {
        sub.status = 'cancelled';
        sub.endedAt = sub.currentPeriodEnd;
      });
      return null;
    }
    store.mutate(() => {
      // Advance whole months until the period covers today (handles a studio
      // that was idle for a while without stacking a month of free credits).
      while (new Date(sub.currentPeriodEnd).getTime() <= Date.now()) {
        sub.currentPeriodStart = sub.currentPeriodEnd;
        sub.currentPeriodEnd = addMonths(new Date(sub.currentPeriodEnd)).toISOString();
        sub.renewals = (sub.renewals || 0) + 1;
      }
      sub.creditsUsed = 0;
      sub.guestPassesUsed = 0;
    });
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
    creditsLeft: unlimited ? Infinity : Math.max(0, plan.monthlyCredits - sub.creditsUsed),
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    // Studio-local calendar dates for display; the ISO fields above stay the
    // source of truth for billing comparisons.
    periodStartDate: dateKey(new Date(sub.currentPeriodStart)),
    periodEndDate: dateKey(new Date(sub.currentPeriodEnd)),
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    guestPassesLeft: Math.max(0, plan.guestPassesPerMonth - (sub.guestPassesUsed || 0)),
  };
}

function addMonths(date, n = 1) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + n;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(targetMonth);
  // Clamp: a 31st subscription renews on the 30th in a 30-day month.
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** Serialisable view of membership() — Infinity does not survive JSON. */
function membershipView(userId) {
  const m = membership(userId);
  if (!m) return null;
  return { ...m, creditsLeft: m.unlimited ? null : m.creditsLeft };
}

// ------------------------------------------------------------ eligibility

/**
 * Can this user take this session, and how would it be paid for?
 *
 * Returns { allowed, method, price, reason }. method is one of:
 *   'credit'   deducted from the monthly allowance
 *   'included' unlimited plan
 *   'pay'      needs a card — member rate if they hold a plan, else drop-in
 */
function evaluate(user, session) {
  const db = store.read();
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

  const m = membership(user.id);
  const plan = m ? m.plan : db.dropIn;

  // Booking window — the headline privilege difference between tiers.
  const windowDays = plan.bookingWindowDays;
  const windowEnd = Date.now() + windowDays * DAY_MS;
  if (starts > windowEnd) {
    const label = m ? `your ${plan.name} membership lets you` : 'without a membership you can';
    return deny(
      `Opens closer to the date — ${label} book ${windowDays} days ahead. ` +
        (m && plan.id !== 'unlimited' ? 'Upgrade for a longer booking window.' : ''),
      'window'
    );
  }

  // Same-day double booking of overlapping classes is a support ticket waiting
  // to happen, so refuse it up front.
  const clash = db.bookings.find((b) => {
    if (b.userId !== user.id || b.status !== 'confirmed') return false;
    const other = getSession(b.sessionId);
    if (!other) return false;
    const gap = Math.abs(new Date(other.startsAt).getTime() - starts);
    return gap < other.duration * 60000;
  });
  if (clash) return deny('That overlaps a class you have already booked.', 'clash');

  if (m && m.unlimited) {
    return { allowed: true, method: 'included', price: 0, waitlist: session.full, plan };
  }
  if (m && m.creditsLeft > 0) {
    return { allowed: true, method: 'credit', price: 0, waitlist: session.full, plan };
  }
  // Waitlists are a credit-backed privilege. Promotion happens hours later,
  // often unattended, and there is no card on file to charge at that moment —
  // so a spot can only be held for someone whose membership already covers it.
  if (session.full) {
    return deny(
      m
        ? `This class is full. Waitlist spots are held for members with classes remaining — ` +
            `you have used all ${plan.monthlyCredits} this cycle.`
        : 'This class is full. Waitlist spots are held for members — a membership starts at $79/month.',
      'full'
    );
  }

  const price = m ? plan.dropInRate : db.dropIn.price;
  return {
    allowed: true,
    method: 'pay',
    price,
    waitlist: session.full,
    plan,
    note: m
      ? `You have used all ${plan.monthlyCredits} classes this cycle. Member rate applies.`
      : 'Single class, no membership needed.',
  };
}

/** `code` lets the UI label a refusal precisely instead of a generic "no". */
function deny(reason, code = 'blocked') {
  return { allowed: false, reason, code };
}

// ---------------------------------------------------------------- actions

/**
 * Reserve a spot. Credit-funded bookings complete immediately; pay-per-class
 * bookings are created as 'pending' and confirmed by lib/payments.js once the
 * charge succeeds, so an abandoned checkout never holds a reformer hostage.
 */
function book(user, sessionId, { paid = false, paymentId = null } = {}) {
  const session = getSession(sessionId);
  const decision = evaluate(user, session);
  if (!decision.allowed) throw httpError(400, decision.reason);
  if (decision.method === 'pay' && !paid) {
    throw httpError(402, 'Payment required for this class.');
  }

  return store.mutate((db) => {
    // Re-read capacity inside the mutation: two members can tap Book at once.
    const live = db.bookings.filter((b) => b.sessionId === sessionId && b.status === 'confirmed');
    const full = live.length >= session.capacity;
    const m = membership(user.id);

    const booking = {
      id: store.id('bkg'),
      userId: user.id,
      sessionId,
      classTypeId: session.classTypeId,
      className: session.className,
      startsAt: session.startsAt,
      // Studio-local date and time are stored alongside the instant. Slicing a
      // UTC ISO string for display is off by a day either side of midnight.
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
    return booking;
  });
}

/**
 * Cancel. Inside the plan's late-cancel window the credit is forfeited — the
 * spot cannot be resold in time, which is exactly why studios charge for it.
 */
function cancel(user, bookingId) {
  return store.mutate((db) => {
    const booking = db.bookings.find((b) => b.id === bookingId && b.userId === user.id);
    if (!booking) throw httpError(404, 'We could not find that booking.');
    if (booking.status === 'cancelled') throw httpError(400, 'That booking is already cancelled.');

    const m = membership(user.id);
    const windowHours = (m ? m.plan.lateCancelHours : db.dropIn.lateCancelHours) || 12;
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

    db.cancellations.push({
      bookingId: booking.id,
      userId: user.id,
      at: booking.cancelledAt,
      late: booking.lateCancel,
    });

    const promoted = promote(db, booking.sessionId);
    return { booking, refundedCredit, late: booking.lateCancel, windowHours, promoted };
  });
}

/**
 * A spot opened. Priority-waitlist members (Essential and Unlimited) are
 * promoted first; within a tier it is first come, first served.
 */
function promote(db, sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const confirmed = db.bookings.filter((b) => b.sessionId === sessionId && b.status === 'confirmed');
  if (confirmed.length >= session.capacity) return null;

  const queue = db.bookings
    .filter((b) => b.sessionId === sessionId && b.status === 'waitlisted')
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

  const next = queue[0];
  if (!next) return null;

  next.status = 'confirmed';
  next.promotedAt = new Date().toISOString();
  if (next.method === 'credit') {
    const sub = db.subscriptions.find((s) => s.userId === next.userId && s.status === 'active');
    if (sub) {
      sub.creditsUsed += 1;
      next.creditUsed = true;
    }
  }
  return next;
}

/** Bookings for the account page, newest class first. */
function bookingsFor(userId) {
  const db = store.read();
  return db.bookings
    .filter((b) => b.userId === userId)
    .map((b) => {
      const session = getSession(b.sessionId);
      const local = new Date(b.startsAt);
      return {
        ...b,
        date: b.date || dateKey(local),
        time:
          b.time ||
          `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
        instructor: session ? session.instructor : '',
        duration: session ? session.duration : null,
        spotsLeft: session ? session.spotsLeft : null,
        past: new Date(b.startsAt).getTime() < Date.now(),
      };
    })
    .sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1));
}

module.exports = {
  listSessions,
  getSession,
  sessionId,
  evaluate,
  book,
  cancel,
  membership,
  membershipView,
  bookingsFor,
  planById,
  addMonths,
  dateKey,
};

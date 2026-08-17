/**
 * The studio catalogue: plans, class types, teachers and the weekly grid.
 *
 * This is the file the studio owner edits. Everything downstream (pricing page,
 * booking rules, schedule generation) reads from here — change a price or add a
 * Thursday 7pm Reformer class and restart; nothing else needs touching.
 */

// ---------------------------------------------------------------- plans
//
// Booking privileges by tier. These are enforced server-side in lib/booking.js.
//
//   monthlyCredits    number of classes included per billing month; null = unlimited
//   bookingWindowDays how far ahead this tier may reserve a spot
//   priorityWaitlist  jumps ahead of non-priority members when a spot frees up
//   dropInRate        what a class costs once credits run out (member rate)
//   guestPassesPerMonth  bring-a-friend allowance
//
const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    tagline: '4 Classes / Month',
    price: 79,
    interval: 'month',
    monthlyCredits: 4,
    bookingWindowDays: 7,
    priorityWaitlist: false,
    dropInRate: 22,
    guestPassesPerMonth: 0,
    lateCancelHours: 12,
    features: [
      '4 classes per month',
      'Member rates on extra classes',
      'Book up to 7 days in advance',
      'Cancel anytime',
    ],
  },
  {
    id: 'essential',
    name: 'Essential',
    tagline: '8 Classes / Month',
    price: 139,
    interval: 'month',
    monthlyCredits: 8,
    bookingWindowDays: 14,
    priorityWaitlist: true,
    dropInRate: 20,
    guestPassesPerMonth: 1,
    lateCancelHours: 12,
    badge: 'Most Popular',
    features: [
      '8 classes per month',
      'Member rates on extra classes',
      'Book up to 14 days in advance',
      'Priority waitlist',
      '1 guest pass per month',
    ],
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    tagline: 'Unlimited Classes',
    price: 199,
    interval: 'month',
    monthlyCredits: null,
    bookingWindowDays: 30,
    priorityWaitlist: true,
    dropInRate: 0,
    guestPassesPerMonth: 2,
    lateCancelHours: 12,
    features: [
      'Unlimited classes',
      'Workshops at member rates',
      'Book up to 30 days in advance',
      'Priority waitlist',
      '2 guest passes per month',
    ],
  },
];

// Not a subscription — a single paid class. Kept alongside the plans so the
// pricing page can show all four options in one row, like the reference design.
const DROP_IN = {
  id: 'dropin',
  name: 'Drop-In',
  tagline: 'Single Class',
  price: 28,
  interval: 'class',
  monthlyCredits: 0,
  bookingWindowDays: 5,
  priorityWaitlist: false,
  dropInRate: 28,
  guestPassesPerMonth: 0,
  lateCancelHours: 12,
  oneOff: true,
  features: ['1 class', 'No commitment', 'Book up to 5 days ahead', 'Flexible scheduling'],
};

// ------------------------------------------------------------ class types

const CLASS_TYPES = [
  {
    id: 'reformer',
    name: 'Reformer Pilates',
    duration: 50,
    level: 'All Levels',
    blurb: 'Full-body strength, flexibility and core control.',
    description:
      'Our signature class on the reformer. Spring resistance builds strength without impact, ' +
      'while the moving carriage asks your deep core to stabilise every repetition. Expect a ' +
      'full-body sequence that leaves you taller, longer and steadier on your feet.',
    image: 'reformer',
  },
  {
    id: 'mat',
    name: 'Mat Pilates',
    duration: 45,
    level: 'All Levels',
    blurb: 'Strengthen, lengthen and improve mobility.',
    description:
      'Classical mat work with small props. No machine, no intimidation, just precise movement ' +
      'and breath. A brilliant place to start, and the class experienced members come back to ' +
      'when they want to feel their technique clearly.',
    image: 'mat',
  },
  {
    id: 'sculpt',
    name: 'Sculpt & Tone',
    duration: 50,
    level: 'Intermediate',
    blurb: 'Pilates-inspired class focused on strength and endurance.',
    description:
      'Higher tempo, heavier springs, light weights. Pilates principles applied to a strength ' +
      'and endurance format. You should be comfortable on the reformer before joining.',
    image: 'sculpt',
  },
  {
    id: 'stretch',
    name: 'Stretch & Mobility',
    duration: 45,
    level: 'All Levels',
    blurb: 'Release tension and restore range of motion.',
    description:
      'A slower, restorative session using the reformer, straps and foam rollers to open hips, ' +
      'shoulders and spine. The perfect counterweight to a heavy training week or a desk job.',
    image: 'stretch',
  },
];

const INSTRUCTORS = [
  { id: 'maya', name: 'Maya Lin', bio: 'Studio founder. 12 years teaching, classical training.' },
  { id: 'sofia', name: 'Sofia Reyes', bio: 'Reformer specialist with a rehab background.' },
  { id: 'jordan', name: 'Jordan Blake', bio: 'Strength and conditioning meets classical Pilates.' },
  { id: 'elise', name: 'Elise Tan', bio: 'Mobility, breath work and pre/postnatal certified.' },
];

// -------------------------------------------------------- weekly schedule
//
// day: 0 = Sunday ... 6 = Saturday. Times are studio-local 24h.
// The server projects this grid forward to produce bookable sessions.

const T = (day, time, classTypeId, instructorId, capacity) => ({
  day,
  time,
  classTypeId,
  instructorId,
  capacity,
});

const SCHEDULE_TEMPLATE = [
  // Monday
  T(1, '06:30', 'reformer', 'sofia', 10),
  T(1, '09:15', 'reformer', 'maya', 10),
  T(1, '12:00', 'mat', 'elise', 16),
  T(1, '17:30', 'sculpt', 'jordan', 10),
  T(1, '18:45', 'reformer', 'sofia', 10),
  // Tuesday
  T(2, '06:30', 'sculpt', 'jordan', 10),
  T(2, '09:15', 'mat', 'elise', 16),
  T(2, '12:00', 'reformer', 'maya', 10),
  T(2, '17:30', 'reformer', 'sofia', 10),
  T(2, '18:45', 'stretch', 'elise', 12),
  // Wednesday
  T(3, '06:30', 'reformer', 'maya', 10),
  T(3, '09:15', 'reformer', 'sofia', 10),
  T(3, '12:00', 'sculpt', 'jordan', 10),
  T(3, '17:30', 'mat', 'elise', 16),
  T(3, '18:45', 'reformer', 'maya', 10),
  // Thursday
  T(4, '06:30', 'mat', 'elise', 16),
  T(4, '09:15', 'sculpt', 'jordan', 10),
  T(4, '12:00', 'reformer', 'sofia', 10),
  T(4, '17:30', 'reformer', 'maya', 10),
  T(4, '18:45', 'stretch', 'elise', 12),
  // Friday
  T(5, '06:30', 'reformer', 'sofia', 10),
  T(5, '09:15', 'sculpt', 'jordan', 10),
  T(5, '12:00', 'mat', 'elise', 16),
  T(5, '17:30', 'reformer', 'maya', 10),
  // Saturday
  T(6, '08:00', 'reformer', 'maya', 10),
  T(6, '09:15', 'sculpt', 'jordan', 10),
  T(6, '10:30', 'mat', 'elise', 16),
  T(6, '11:45', 'stretch', 'sofia', 12),
  // Sunday
  T(0, '09:00', 'stretch', 'elise', 12),
  T(0, '10:15', 'reformer', 'sofia', 10),
  T(0, '11:30', 'mat', 'maya', 16),
];

const STUDIO = {
  name: 'Core Pilates Studio',
  tagline: 'Stronger body. Calmer mind.',
  address: '123 Wellness Way, Toronto, ON',
  phone: '(416) 123-4567',
  email: 'hello@corepilates.com',
  hours: 'Mon–Fri 6am–8pm · Sat–Sun 8am–1pm',
  currency: 'CAD',
  // How far ahead sessions are generated. Must exceed the largest booking window.
  scheduleHorizonDays: 45,
};

function build() {
  return {
    studio: STUDIO,
    plans: PLANS,
    dropIn: DROP_IN,
    classTypes: CLASS_TYPES,
    instructors: INSTRUCTORS,
    scheduleTemplate: SCHEDULE_TEMPLATE,
    users: [],
    subscriptions: [],
    bookings: [],
    payments: [],
    messages: [],
    cancellations: [],
  };
}

module.exports = { build, PLANS, DROP_IN, CLASS_TYPES, STUDIO };

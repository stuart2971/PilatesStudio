# Core Pilates Studio

A booking and membership website for a Pilates studio: class scheduling, recurring
monthly memberships with tiered booking privileges, waitlists and card checkout.

Roughly what Wix Bookings + Wix Pricing Plans give you, built as a small Node app
with no npm dependencies, so the rules are readable and the data is yours.

**Live demo:** https://stuart2971.github.io/PilatesStudio/

---

## Running it

```bash
node server.js
```

Node 18 or newer. No `npm install` — there are no dependencies. The site is at
http://localhost:3000, and `data/db.json` is created on first boot.

Payments start in **demo mode**: checkout renders the studio's own card form and
approves it locally so the whole flow can be clicked through. Nothing is charged.

---

## Membership tiers and what they unlock

Every privilege below is a field on the plan record in `lib/seed.js` and is
enforced server-side in `lib/booking.js`. The browser decides what to *show*; it
never decides what a member may do.

| | Starter | Essential | Unlimited | Drop-In |
|---|---|---|---|---|
| Price | $79/mo | $139/mo | $199/mo | $28/class |
| Classes included | 4 / month | 8 / month | Unlimited | pay per class |
| **Booking window** | 7 days | 14 days | 30 days | 5 days |
| **Priority waitlist** | — | yes | yes | — |
| Extra class rate | $22 | $20 | included | $28 |
| Guest passes | — | 1 / month | 2 / month | — |
| Free cancellation | 12h before | 12h before | 12h before | 12h before |

The rules these produce:

- **Booking window.** How far ahead a tier may reserve. Every class is visible to
  everyone; anything past your window is labelled *Not yet open* rather than hidden.
- **Class credits.** Deducted on booking, restored on cancellation more than 12
  hours out, forfeited inside that window — the spot cannot be resold that late.
- **Renewal.** Billing periods roll forward lazily and reset the allowance; a
  membership bought on the 31st renews on the 30th in a 30-day month.
- **Running out.** Members keep booking at their member rate rather than being
  stopped, which is cheaper than the public drop-in price.
- **Waitlists.** Members only, and only while they have a class remaining —
  promotion happens hours later with no card on file to charge. Priority tiers are
  promoted first; within a tier it is first come, first served. No credit is spent
  until you are actually promoted in.
- **Switching plans** replaces the old membership immediately and starts a fresh
  cycle. **Cancelling** stops the renewal and keeps access to the end of the paid
  period; it can be resumed until then.

Change a price, a class time or a privilege in `lib/seed.js` and restart. Customer
records are untouched — only the catalogue is re-read.

---

## Taking real payments

Add a Stripe secret key to `.env` and checkout switches from the demo form to real
Stripe Checkout — subscription mode for memberships, one-off payment mode for
drop-ins. No code changes; `lib/payments.js` has one interface and two backends.

```bash
cp .env.example .env
# then edit:
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Memberships are activated by the **webhook**, not by the browser landing on the
success page — that is the only signal Stripe guarantees. Forward events locally
with:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Handled events: `checkout.session.completed` (activate), `invoice.paid` (monthly
renewal, resets the allowance), `customer.subscription.deleted` (end it). Every
webhook signature is verified before the payload is trusted.

---

## Layout

```
server.js                 static host + API routing, no dependencies
lib/
  seed.js                 the catalogue: plans, classes, teachers, weekly grid
  store.js                JSON-file datastore with atomic writes
  auth.js                 scrypt passwords, signed-cookie sessions
  booking.js              the booking engine — schedule, eligibility, credits
  payments.js             Stripe adapter with a demo-mode fallback
  api.js                  JSON endpoints
public/                   the site
  assets/js/app.js        shared chrome, API client, auth modal
  assets/js/book.js       the four-step booking wizard
  assets/js/static-api.js the same engine in the browser, for static hosting
scripts/build-catalogue.js exports the catalogue for the static build
data/db.json              created at runtime, git-ignored
```

Sessions are **derived, not stored**: the weekly grid in `lib/seed.js` is projected
forward on demand, so the timetable never needs backfilling and a change applies to
every future date at once. Only what a customer actually did — bookings, payments —
is persisted.

---

## The GitHub Pages build

GitHub Pages serves static files and runs no server, so there is nothing there to
answer `/api/*`. Rather than ship a site where every button fails, `static-api.js`
implements the same endpoints against `localStorage`, with the same booking
windows, credits, waitlist priority and cancellation rules. It activates only when
no API responds — run `node server.js` and it stays dormant.

The demo deployment therefore:

- keeps all data in that one browser, and resets when site data is cleared;
- cannot verify a login against anything, because there is no server;
- charges no card and never contacts Stripe.

A banner says so on every page. For a real studio, deploy `server.js` to any host
that runs Node (Render, Railway, Fly, a VPS) and the same front end talks to it
with no changes.

`.github/workflows/pages.yml` publishes `public/` on every push to `main`.

**One-time setup, needed before the first deploy can succeed:**

1. Open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open **Actions**, pick the latest *Deploy to GitHub Pages* run and press
   **Re-run all jobs** (or push any commit).

The workflow asks GitHub to turn Pages on by itself, but that API call is
refused on some accounts, so the switch above may have to be flipped by hand.
Once Pages exists, every later push deploys with no further steps.

---

## Testing

`node scripts/build-catalogue.js` regenerates the static catalogue after editing
`lib/seed.js`. Do this before deploying, or the Pages demo will show stale prices.

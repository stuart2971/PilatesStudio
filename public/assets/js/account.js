/* ==========================================================================
   Account: membership state, class credits, bookings, billing history.
   Everything shown here comes from /api/me — one call, always authoritative.
   ========================================================================== */

(async () => {
  const root = document.getElementById('account-root');
  const params = new URLSearchParams(location.search);
  let tab = 'upcoming';

  await App.config();
  await App.refresh();

  function signedOut() {
    document.getElementById('greeting').textContent = 'My Account';
    root.innerHTML = `
      <div class="panel center" style="padding:3.5rem 1.5rem">
        <h2>Log in to see your classes</h2>
        <p class="lede" style="margin:0 auto 1.8rem">
          Your bookings, class credits and membership all live here.
        </p>
        <div class="row" style="justify-content:center">
          <button class="btn" data-auth="login">Log In</button>
          <button class="btn btn-ghost" data-auth="signup">Create Account</button>
        </div>
      </div>`;
    root.querySelectorAll('[data-auth]').forEach((b) =>
      b.addEventListener('click', () => App.openAuth(b.dataset.auth))
    );
  }

  function membershipCard(m) {
    if (!m) {
      return `
        <div class="panel spread" style="margin-bottom:1.6rem">
          <div>
            <h2 style="font-size:1.3rem;margin-bottom:.2rem">No membership yet</h2>
            <p class="muted" style="margin:0">
              You can keep paying per class as a drop-in, or save with a monthly plan
              from $79 and unlock longer booking windows.
            </p>
          </div>
          <a class="btn" href="memberships.html">View Plans</a>
        </div>`;
    }

    const renews = App.formatDate(m.periodEndDate);
    return `
      <div class="panel" style="margin-bottom:1.6rem">
        <div class="spread" style="margin-bottom:1.4rem">
          <div>
            <p class="eyebrow" style="margin-bottom:.3rem">Membership</p>
            <h2 style="font-size:1.6rem;margin:0">${App.escapeHtml(m.plan.name)}</h2>
          </div>
          <div class="row">
            ${
              m.cancelAtPeriodEnd
                ? `<span class="pill pill-warn">Ends ${App.formatDate(m.periodEndDate, 'short')}</span>
                   <button class="btn btn-sm" id="resume-plan">Resume Membership</button>`
                : `<span class="pill pill-ok">Active</span>
                   <a class="btn btn-sm btn-ghost" href="memberships.html">Change Plan</a>
                   <button class="btn btn-sm btn-ghost" id="cancel-plan">Cancel</button>`
            }
          </div>
        </div>
        <div class="stat-row" style="margin-bottom:0">
          <div class="stat">
            <div class="stat-label">Classes left</div>
            <div class="stat-value">${m.unlimited ? '∞' : m.creditsLeft}</div>
            <div class="stat-sub">${m.unlimited ? 'Unlimited plan' : `of ${m.creditsTotal} this cycle`}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Booking window</div>
            <div class="stat-value">${m.plan.bookingWindowDays}</div>
            <div class="stat-sub">days ahead</div>
          </div>
          <div class="stat">
            <div class="stat-label">Waitlist</div>
            <div class="stat-value" style="font-size:1.4rem">${m.plan.priorityWaitlist ? 'Priority' : 'Standard'}</div>
            <div class="stat-sub">${m.plan.priorityWaitlist ? 'Promoted first' : 'First come, first served'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${m.cancelAtPeriodEnd ? 'Access until' : 'Renews'}</div>
            <div class="stat-value" style="font-size:1.4rem">${App.formatDate(m.periodEndDate, 'short')}</div>
            <div class="stat-sub">$${m.plan.price} / month</div>
          </div>
        </div>
      </div>`;
  }

  function bookingRow(b) {
    const date = b.date;
    const d = App.parseDate(date);
    const time = b.time;
    const status =
      b.status === 'waitlisted'
        ? '<span class="pill pill-warn">Waitlisted</span>'
        : b.status === 'cancelled'
          ? `<span class="pill">Cancelled${b.lateCancel ? ' · late' : ''}</span>`
          : b.past
            ? '<span class="pill">Attended</span>'
            : '<span class="pill pill-ok">Confirmed</span>';

    const canCancel = b.status !== 'cancelled' && !b.past;
    return `
      <div class="booking-row ${b.past ? 'past' : ''}">
        <div class="booking-when">
          <div class="d">${d.getDate()}</div>
          <div class="m">${App.MONTHS[d.getMonth()].slice(0, 3)}</div>
        </div>
        <div class="booking-main">
          <strong>${App.escapeHtml(b.className)}</strong>
          <small>
            ${App.formatTime(time)} · ${b.duration ? b.duration + ' min · ' : ''}${App.escapeHtml(b.instructor || '')}
            ${b.method === 'pay' && b.amountPaid ? ` · $${b.amountPaid} paid` : ''}
            ${b.creditUsed ? ' · 1 credit' : ''}
          </small>
        </div>
        <div class="row">
          ${status}
          ${canCancel ? `<button class="btn btn-sm btn-ghost" data-cancel="${b.id}">Cancel</button>` : ''}
        </div>
      </div>`;
  }

  function render() {
    const me = App.state.me;
    if (!me || !me.user) return signedOut();

    document.getElementById('greeting').textContent = `Hi, ${me.user.name.split(' ')[0]}`;
    document.getElementById('logout').classList.remove('hidden');

    const upcoming = me.bookings.filter((b) => !b.past && b.status !== 'cancelled');
    const past = me.bookings.filter((b) => b.past || b.status === 'cancelled');
    const list = tab === 'upcoming' ? upcoming : tab === 'past' ? past : [];

    root.innerHTML = `
      ${membershipCard(me.membership)}

      <div class="panel">
        <div class="tabs">
          <button data-tab="upcoming" class="${tab === 'upcoming' ? 'active' : ''}">
            Upcoming (${upcoming.length})</button>
          <button data-tab="past" class="${tab === 'past' ? 'active' : ''}">
            History (${past.length})</button>
          <button data-tab="billing" class="${tab === 'billing' ? 'active' : ''}">
            Billing (${me.payments.length})</button>
          <button data-tab="profile" class="${tab === 'profile' ? 'active' : ''}">Profile</button>
        </div>

        ${
          tab === 'billing'
            ? me.payments.length
              ? me.payments.map((p) => `
                  <div class="booking-row">
                    <div class="booking-main">
                      <strong>${App.escapeHtml(p.description)}</strong>
                      <small>${App.formatDate(App.dateKey(new Date(p.paidAt)))}
                        ${p.card ? ` · ${p.card.brand} ···· ${p.card.last4}` : ''}</small>
                    </div>
                    <div class="row"><strong>$${p.amount} ${p.currency}</strong></div>
                  </div>`).join('')
              : `<p class="muted" style="padding:1.5rem 0;margin:0">No payments yet.</p>`
            : tab === 'profile'
              ? `<form id="profile-form" style="max-width:420px;padding-top:1rem">
                   <label class="field"><span>Name</span>
                     <input name="name" value="${App.escapeHtml(me.user.name)}" required></label>
                   <label class="field"><span>Email</span>
                     <input value="${App.escapeHtml(me.user.email)}" disabled></label>
                   <label class="field"><span>Mobile</span>
                     <input name="phone" type="tel" value="${App.escapeHtml(me.user.phone || '')}"></label>
                   <button class="btn btn-sm" type="submit">Save Changes</button>
                 </form>`
              : list.length
                ? list.map(bookingRow).join('')
                : `<div style="padding:2.5rem 0;text-align:center">
                     <p class="muted">${tab === 'upcoming' ? 'No classes booked yet.' : 'Nothing here yet.'}</p>
                     ${tab === 'upcoming' ? '<a class="btn btn-sm" href="book.html">Book a Class</a>' : ''}
                   </div>`
        }
      </div>`;

    wire();
  }

  function wire() {
    root.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        render();
      })
    );

    root.querySelectorAll('[data-cancel]').forEach((b) =>
      b.addEventListener('click', () => cancelBooking(b))
    );

    const cancelPlan = document.getElementById('cancel-plan');
    if (cancelPlan) cancelPlan.addEventListener('click', cancelMembership);

    const resumePlan = document.getElementById('resume-plan');
    if (resumePlan)
      resumePlan.addEventListener('click', async () => {
        resumePlan.disabled = true;
        try {
          App.setMe(await App.post('api/membership/resume'));
          App.toast('Membership resumed.', 'good');
          render();
        } catch (err) {
          App.toast(err.message, 'bad');
          resumePlan.disabled = false;
        }
      });

    const profile = document.getElementById('profile-form');
    if (profile)
      profile.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = profile.querySelector('button');
        btn.disabled = true;
        try {
          App.setMe(await App.post('api/me', Object.fromEntries(new FormData(profile))));
          App.toast('Profile saved.', 'good');
          render();
        } catch (err) {
          App.toast(err.message, 'bad');
          btn.disabled = false;
        }
      });
  }

  async function cancelBooking(btn) {
    const id = btn.dataset.cancel;
    const booking = App.state.me.bookings.find((b) => b.id === id);
    const hoursOut = (new Date(booking.startsAt).getTime() - Date.now()) / 3600000;
    const window = App.state.me.membership ? App.state.me.membership.plan.lateCancelHours : 12;

    const warning =
      hoursOut < window && booking.creditUsed
        ? `\n\nThis is inside the ${window}-hour window, so the class credit will not come back.`
        : '';
    if (!confirm(`Cancel ${booking.className} on ${App.formatDate(booking.date)}?${warning}`))
      return;

    btn.disabled = true;
    try {
      const result = await App.post('api/bookings/cancel', { bookingId: id });
      App.setMe(result);
      App.toast(
        result.refundedCredit
          ? 'Cancelled — your class credit is back.'
          : result.late
            ? `Cancelled inside the ${result.windowHours}-hour window.`
            : 'Booking cancelled.',
        result.refundedCredit ? 'good' : ''
      );
      render();
    } catch (err) {
      App.toast(err.message, 'bad');
      btn.disabled = false;
    }
  }

  async function cancelMembership() {
    const m = App.state.me.membership;
    const until = App.formatDate(m.periodEndDate);
    if (
      !confirm(
        `Cancel your ${m.plan.name} membership?\n\nYou keep full access until ${until}, ` +
          `and you will not be billed again. You can resume before then.`
      )
    )
      return;

    try {
      App.setMe(await App.post('api/membership/cancel'));
      App.toast(`Membership ends ${until}. You can resume any time before then.`);
      render();
    } catch (err) {
      App.toast(err.message, 'bad');
    }
  }

  document.getElementById('logout').addEventListener('click', async () => {
    await App.logout();
    location.href = 'index.html';
  });

  App.onUserChange(render);
  render();

  // Post-checkout landings.
  const welcome = params.get('welcome');
  if (welcome) {
    App.toast('Membership active. Your classes are ready to book.', 'good');
    history.replaceState({}, '', 'account.html');
  }
  if (params.get('booked')) {
    App.toast('Payment received — you are booked in.', 'good');
    history.replaceState({}, '', 'account.html');
  }
})();

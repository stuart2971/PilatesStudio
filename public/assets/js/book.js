/* ==========================================================================
   Booking wizard: class → date → time → details → confirm.

   The schedule and the per-user verdict for every session both come from
   /api/sessions, so the calendar can grey out dates outside the member's
   booking window without guessing at the rules. The final Confirm still goes
   through the server, which re-checks everything.
   ========================================================================== */

(async () => {
  const STEPS = ['Choose Class', 'Choose Time', 'Your Info', 'Confirm'];
  const params = new URLSearchParams(location.search);

  const sel = {
    classTypeId: params.get('class') || null,
    date: null,
    session: null,
    step: 1,
  };

  let sessions = [];
  let membership = null;
  let config = null;
  let month = new Date();
  month.setDate(1);

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- data

  async function loadSessions() {
    const data = await App.get('api/sessions');
    sessions = data.sessions;
    membership = data.membership;
  }

  const forClass = () => sessions.filter((s) => s.classTypeId === sel.classTypeId);
  const datesWithClasses = () => new Set(forClass().map((s) => s.date));

  // ------------------------------------------------------------ steps

  function renderSteps() {
    $('steps').innerHTML = STEPS.map((label, i) => {
      const n = i + 1;
      const cls = sel.step === n ? 'active' : sel.step > n ? 'done' : '';
      return `
        <div class="step ${cls}"><span class="step-num">${sel.step > n ? '✓' : n}</span>${label}</div>
        ${n < STEPS.length ? '<div class="step-line"></div>' : ''}`;
    }).join('');
  }

  function show(screen) {
    ['pick', 'details', 'confirm', 'done'].forEach((name) => {
      $('screen-' + name).classList.toggle('hidden', name !== screen);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goStep(n, screen) {
    sel.step = n;
    renderSteps();
    show(screen);
  }

  // ------------------------------------------------------- class list

  function renderClasses() {
    $('class-list').innerHTML = config.classTypes.map((c) => {
      const count = sessions.filter((s) => s.classTypeId === c.id).length;
      return `
        <button class="choice ${sel.classTypeId === c.id ? 'selected' : ''}" data-class="${c.id}">
          <span>
            <strong>${App.escapeHtml(c.name)}</strong>
            <small>${c.duration} min · ${App.escapeHtml(c.level)} · ${count} upcoming</small>
          </span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
        </button>`;
    }).join('');

    $('class-list').querySelectorAll('[data-class]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.classTypeId = btn.dataset.class;
        sel.session = null;
        // Jump the calendar to the first month that actually has this class.
        const first = forClass()[0];
        if (first) {
          const d = App.parseDate(first.date);
          month = new Date(d.getFullYear(), d.getMonth(), 1);
          if (!sel.date || !datesWithClasses().has(sel.date)) sel.date = first.date;
        }
        renderAll();
      });
    });
  }

  // --------------------------------------------------------- calendar

  function renderCalendar() {
    $('cal-dow').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map((d) => `<div class="cal-dow">${d}</div>`)
      .join('');
    $('cal-label').textContent = `${App.MONTHS[month.getMonth()]} ${month.getFullYear()}`;

    const withClasses = datesWithClasses();
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // grid starts Monday

    let html = '';
    for (let i = 0; i < lead; i++) html += '<div></div>';
    for (let day = 1; day <= days; day++) {
      const key = App.dateKey(new Date(month.getFullYear(), month.getMonth(), day));
      const has = withClasses.has(key);
      const bookable = has && forClass().some((s) => s.date === key && (!s.verdict || s.verdict.allowed));
      html += `
        <button class="cal-day ${has ? 'has-classes' : ''} ${sel.date === key ? 'selected' : ''}
                 ${has && !bookable ? 'outside-window' : ''}"
                data-date="${key}" ${has ? '' : 'disabled'}
                aria-label="${App.formatDate(key)}">${day}</button>`;
    }
    $('cal-days').innerHTML = html;

    $('cal-days').querySelectorAll('[data-date]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.date = btn.dataset.date;
        sel.session = null;
        renderCalendar();
        renderTimes();
        renderPickBar();
      });
    });

    // Do not let people wander back past today, or beyond the last session.
    const now = new Date();
    $('cal-prev').disabled =
      month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();
    const last = sessions.length ? App.parseDate(sessions[sessions.length - 1].date) : now;
    $('cal-next').disabled =
      month.getFullYear() === last.getFullYear() && month.getMonth() >= last.getMonth();
  }

  // ------------------------------------------------------------ times

  function renderTimes() {
    const host = $('times');
    if (!sel.classTypeId || !sel.date) {
      host.innerHTML = `<p class="muted" style="font-size:.88rem;margin:0">Pick a class and a date to see times.</p>`;
      return;
    }
    const slots = forClass().filter((s) => s.date === sel.date);
    if (!slots.length) {
      host.innerHTML = `<p class="muted" style="font-size:.88rem;margin:0">No ${
        config.classTypes.find((c) => c.id === sel.classTypeId).name
      } classes on this date.</p>`;
      return;
    }

    host.innerHTML = slots.map((s) => {
      const v = s.verdict;
      const blocked = v && !v.allowed;
      const waitlist = s.full;
      const note = blocked
        ? { booked: 'Booked', waitlisted: 'Waiting', window: 'Not yet', full: 'Full',
            clash: 'Clashes', started: 'Started' }[v.code] || 'Unavailable'
        : waitlist
          ? 'Waitlist'
          : `${s.spotsLeft} left`;
      return `
        <button class="time-chip ${sel.session === s.id ? 'selected' : ''} ${waitlist ? 'waitlist' : ''}"
                data-session="${s.id}" ${blocked ? 'disabled' : ''}
                title="${blocked ? App.escapeHtml(v.reason) : `${App.escapeHtml(s.instructor)} · ${s.duration} min`}">
          ${App.formatTime(s.time)}<em>${note}</em>
        </button>`;
    }).join('');

    host.querySelectorAll('[data-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sel.session = btn.dataset.session;
        renderTimes();
        renderPickBar();
      });
    });

    // Explain a blocked date rather than leaving a row of dead buttons.
    const blockedReason = slots.map((s) => s.verdict).find((v) => v && !v.allowed && v.reason);
    if (blockedReason && slots.every((s) => s.verdict && !s.verdict.allowed)) {
      host.insertAdjacentHTML(
        'beforeend',
        `<p class="callout callout-warn" style="width:100%;margin:.6rem 0 0">${App.escapeHtml(
          blockedReason.reason
        )}</p>`
      );
    }
  }

  function currentSession() {
    return sessions.find((s) => s.id === sel.session) || null;
  }

  function renderPickBar() {
    const s = currentSession();
    $('pick-summary').innerHTML = s
      ? `<strong style="font-weight:500;color:var(--ink)">${App.escapeHtml(s.className)}</strong>
         · ${App.formatDate(s.date)} at ${App.formatTime(s.time)}
         · ${App.escapeHtml(s.instructor)}${s.full ? ' · <span class="pill pill-warn">Waitlist</span>' : ''}`
      : 'Nothing selected yet.';
    $('to-details').disabled = !s;
  }

  // ---------------------------------------------------------- details

  function summaryCard(session) {
    const c = config.classTypes.find((x) => x.id === session.classTypeId);
    return `
      <div class="photo ratio-4x3" style="border-radius:var(--radius);margin-bottom:1.1rem">
        <img src="assets/photos/${c.image}.svg" alt="">
      </div>
      <h3 style="margin-bottom:.6rem">${App.escapeHtml(session.className)}</h3>
      <div class="summary">
        <div class="summary-row"><span>Date</span><span>${App.formatDate(session.date)}</span></div>
        <div class="summary-row"><span>Time</span><span>${App.formatTime(session.time)}</span></div>
        <div class="summary-row"><span>Duration</span><span>${session.duration} min</span></div>
        <div class="summary-row"><span>Instructor</span><span>${App.escapeHtml(session.instructor)}</span></div>
        <div class="summary-row"><span>Level</span><span>${App.escapeHtml(session.level)}</span></div>
        <div class="summary-row"><span>Spots</span><span>${
          session.full ? 'Full — waitlist' : `${session.spotsLeft} of ${session.capacity} left`
        }</span></div>
      </div>`;
  }

  function renderDetails() {
    const s = currentSession();
    $('details-summary').innerHTML = summaryCard(s);
    const me = App.state.me;

    if (!me || !me.user) {
      $('details-body').innerHTML = `
        <p>Bookings are tied to an account so you can manage, cancel and track your classes.</p>
        <div class="row" style="margin:1.4rem 0">
          <button class="btn" data-auth="signup">Create Account</button>
          <button class="btn btn-ghost" data-auth="login">I already have one</button>
        </div>
        <div class="callout">
          Takes about twenty seconds. We only ask for a name, email and password.
        </div>`;
      $('details-body').querySelectorAll('[data-auth]').forEach((b) => {
        b.addEventListener('click', async () => {
          const session = await App.requireAuth(b.dataset.auth);
          if (session) {
            await loadSessions();
            renderDetails();
          }
        });
      });
      $('to-confirm').disabled = true;
      return;
    }

    $('to-confirm').disabled = false;
    const m = me.membership;
    $('details-body').innerHTML = `
      <div class="field-row">
        <label class="field"><span>Name</span><input id="d-name" value="${App.escapeHtml(me.user.name)}"></label>
        <label class="field"><span>Mobile</span><input id="d-phone" type="tel" value="${App.escapeHtml(me.user.phone || '')}" placeholder="Optional"></label>
      </div>
      <label class="field"><span>Email</span><input value="${App.escapeHtml(me.user.email)}" disabled></label>
      <div class="callout ${m ? 'callout-accent' : ''}" style="margin-top:.4rem">
        ${
          m
            ? `<strong>${App.escapeHtml(m.plan.name)} membership</strong> — ${
                m.unlimited
                  ? 'unlimited classes'
                  : `${m.creditsLeft} of ${m.creditsTotal} classes left this cycle`
              }, booking up to ${m.plan.bookingWindowDays} days ahead.`
            : `No membership yet — this class will be a $${config.dropIn.price} drop-in.
               <a class="link-accent" href="memberships.html">See monthly plans</a>`
        }
      </div>`;
  }

  // ---------------------------------------------------------- confirm

  let verdict = null;

  async function renderConfirm() {
    const s = currentSession();
    $('confirm-side').innerHTML = summaryCard(s);
    $('confirm-body').innerHTML = `<div class="skeleton" style="height:160px"></div>`;

    try {
      const data = await App.get('api/bookings/preview?session=' + encodeURIComponent(sel.session));
      verdict = data.verdict;
      membership = data.membership;
    } catch (err) {
      $('confirm-body').innerHTML = `<div class="form-error">${App.escapeHtml(err.message)}</div>`;
      $('do-book').disabled = true;
      return;
    }

    if (!verdict.allowed) {
      $('confirm-body').innerHTML = `
        <div class="form-error">${App.escapeHtml(verdict.reason)}</div>
        <a class="btn btn-ghost" href="book.html">Choose another class</a>`;
      $('do-book').disabled = true;
      return;
    }

    const waitlist = verdict.waitlist;

    // Built per branch, not as a lookup table: the credit variant reads the
    // membership, which is null for a drop-in customer.
    let lines;
    if (verdict.method === 'included') {
      lines = ['Covered by membership', 'Unlimited plan — no credit used', '$0'];
    } else if (verdict.method === 'credit') {
      lines = [
        '1 class credit',
        `${membership.creditsLeft - 1} of ${membership.creditsTotal} remaining after this booking`,
        '$0',
      ];
    } else {
      lines = [membership ? 'Member rate' : 'Drop-in class', verdict.note || '', `$${verdict.price}`];
    }

    $('confirm-body').innerHTML = `
      ${
        waitlist
          ? `<div class="callout callout-warn" style="margin-bottom:1.2rem">
               <strong>This class is full.</strong> You will join the waitlist${
                 membership && membership.plan.priorityWaitlist
                   ? ' with priority placement — your tier is promoted first when a spot opens.'
                   : '.'
               } Nothing is charged and no credit is used unless you get in.
             </div>`
          : ''
      }
      <div class="summary" style="margin-bottom:1.4rem">
        <div class="summary-row"><span>${lines[0]}</span><span>${lines[2]}</span></div>
        ${lines[1] ? `<div class="summary-row"><span style="font-size:.82rem">${App.escapeHtml(lines[1])}</span><span></span></div>` : ''}
        <div class="summary-row total"><span>Total today</span><span>${waitlist ? '$0' : lines[2]}</span></div>
      </div>
      <div class="callout">
        Free cancellation up to ${(membership ? membership.plan.lateCancelHours : 12)} hours before the class.
        Cancel any time from <a class="link-accent" href="account.html">your account</a>.
      </div>`;

    $('do-book').disabled = false;
    $('do-book').textContent = waitlist
      ? 'Join Waitlist'
      : verdict.method === 'pay'
        ? `Pay $${verdict.price} & Confirm`
        : 'Confirm Booking';
  }

  // ------------------------------------------------------------ submit

  async function submit() {
    const btn = $('do-book');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';

    try {
      // Save any edits made on the details step before the booking is written.
      const name = $('d-name') ? $('d-name').value : null;
      const phone = $('d-phone') ? $('d-phone').value : null;
      if (name) await App.post('api/me', { name, phone });

      if (verdict.method === 'pay' && !verdict.waitlist) {
        const { url } = await App.post('api/checkout/class', { sessionId: sel.session });
        location.href = url;
        return;
      }

      const result = await App.post('api/bookings', { sessionId: sel.session });
      App.setMe(result);
      done(result.booking);
    } catch (err) {
      App.toast(err.message, 'bad');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function done(booking) {
    const s = currentSession();
    const waitlisted = booking.status === 'waitlisted';
    goStep(4, 'done');
    $('done-body').innerHTML = `
      <div style="width:56px;height:56px;border-radius:50%;background:var(--accent-soft);
                  display:grid;place-items:center;margin:0 auto 1.4rem">
        <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:var(--accent-dark);stroke-width:2">
          <path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h2 style="margin-bottom:.4rem">${waitlisted ? 'You are on the waitlist' : 'You are booked in'}</h2>
      <p class="lede" style="margin:0 auto 1.8rem">
        ${App.escapeHtml(s.className)} · ${App.formatDate(s.date)} at ${App.formatTime(s.time)}
        with ${App.escapeHtml(s.instructor)}.
        ${waitlisted ? ' We will move you in automatically if a spot opens.' : ' Arrive five minutes early with grip socks.'}
      </p>
      <div class="row" style="justify-content:center">
        <a class="btn" href="account.html">View My Bookings</a>
        <a class="btn btn-ghost" href="book.html">Book Another</a>
      </div>`;
  }

  // -------------------------------------------------------------- boot

  function renderAll() {
    renderClasses();
    renderCalendar();
    renderTimes();
    renderPickBar();
  }

  config = await App.config();
  await loadSessions();

  // Deep link from the schedule page: ?session=<id> lands straight on confirm.
  const deep = params.get('session');
  if (deep && sessions.some((s) => s.id === deep)) {
    const s = sessions.find((x) => x.id === deep);
    sel.classTypeId = s.classTypeId;
    sel.date = s.date;
    sel.session = s.id;
    month = new Date(App.parseDate(s.date).getFullYear(), App.parseDate(s.date).getMonth(), 1);
  } else if (!sel.classTypeId) {
    sel.classTypeId = config.classTypes[0].id;
  }
  if (!sel.date) {
    const first = forClass()[0];
    if (first) {
      sel.date = first.date;
      month = new Date(App.parseDate(first.date).getFullYear(), App.parseDate(first.date).getMonth(), 1);
    }
  }

  renderSteps();
  renderAll();

  $('cal-prev').addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    renderCalendar();
  });

  $('to-details').addEventListener('click', () => {
    goStep(3, 'details');
    renderDetails();
  });
  $('to-confirm').addEventListener('click', () => {
    goStep(4, 'confirm');
    renderConfirm();
  });
  $('do-book').addEventListener('click', submit);

  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => {
      const target = b.dataset.back;
      goStep(target === 'pick' ? 2 : 3, target);
      if (target === 'details') renderDetails();
    });
  });

  // Signing in mid-flow changes what is bookable — reload verdicts.
  App.onUserChange(async (me) => {
    if (!me) return;
    await loadSessions();
    if (!$('screen-pick').classList.contains('hidden')) renderAll();
  });

  if (deep) {
    goStep(3, 'details');
    renderDetails();
  }
  if (params.get('cancelled')) App.toast('Payment cancelled — the class was not booked.');
})();

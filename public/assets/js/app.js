/* ==========================================================================
   Shared front end: API client, chrome (header/footer), auth modal, toasts.
   Loaded by every page. Page-specific logic lives in its own file and calls
   into App.*.
   ========================================================================== */

const App = (() => {
  const state = { me: null, config: null, loaded: false };
  const listeners = new Set();

  // ------------------------------------------------------------ api

  const hasStaticFallback = () => typeof StaticAPI !== 'undefined';

  /**
   * Talks to the Node API when one is running. On a static host (GitHub Pages,
   * a file:// copy) there is no server to answer /api/*, so the first request
   * that comes back as something other than JSON switches the whole page over
   * to the in-browser engine in static-api.js and replays itself there.
   */
  async function api(path, options = {}) {
    if (hasStaticFallback() && StaticAPI.enabled) return StaticAPI.handle(path, options);

    let res;
    try {
      res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (networkError) {
      if (hasStaticFallback()) {
        StaticAPI.enable();
        return StaticAPI.handle(path, options);
      }
      throw new Error('Could not reach the studio. Check your connection and try again.');
    }

    // A static host answers an unknown path with its 404 page, not JSON.
    if (!(res.headers.get('content-type') || '').includes('application/json')) {
      if (hasStaticFallback()) {
        StaticAPI.enable();
        return StaticAPI.handle(path, options);
      }
      throw new Error('The booking service is unavailable right now.');
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const get = (p) => api(p);
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });

  // ---------------------------------------------------------- session

  function setMe(data) {
    state.me = data && data.user ? data : null;
    state.loaded = true;
    renderHeaderActions();
    listeners.forEach((fn) => fn(state.me));
  }

  function onUserChange(fn) {
    listeners.add(fn);
    if (state.loaded) fn(state.me);
    return () => listeners.delete(fn);
  }

  async function refresh() {
    setMe(await get('api/me'));
    return state.me;
  }

  async function config() {
    if (!state.config) state.config = await get('api/config');
    return state.config;
  }

  // ------------------------------------------------------------ icons

  const icons = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    level: '<path d="M4 20V14M10 20V9M16 20V12M22 20V5"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    heart:
      '<path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.7 8.8-8.7a5 5 0 0 0 0-7.1z"/>',
    users:
      '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    phone:
      '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
    instagram:
      '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/>',
    facebook: '<path d="M15 2h-3a5 5 0 0 0-5 5v3H4v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  };

  function icon(name, cls = 'icon') {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
  }

  // ------------------------------------------------------------ chrome

  const NAV = [
    ['Home', 'index.html'],
    ['Classes', 'classes.html'],
    ['Memberships', 'memberships.html'],
    ['Schedule', 'schedule.html'],
    ['About', 'about.html'],
    ['Contact', 'contact.html'],
  ];

  /**
   * Filename of the page being viewed. Compared by basename rather than full
   * path because the site is served both from a domain root and from a project
   * subpath on GitHub Pages.
   */
  function currentPath() {
    const file = location.pathname.split('/').pop();
    return !file || file === '' ? 'index.html' : file;
  }

  function renderChrome() {
    const headerHost = document.getElementById('site-header');
    if (headerHost) {
      const here = currentPath();
      headerHost.outerHTML = `
        <header class="site-header">
          <div class="container header-inner">
            <a class="brand" href="index.html" aria-label="Core Pilates Studio, home">
              <span class="brand-name">CORE</span>
              <span class="brand-sub">Pilates Studio</span>
            </a>
            <nav class="nav" id="primary-nav">
              ${NAV.map(
                ([label, href]) =>
                  `<a href="${href}"${here === href ? ' aria-current="page"' : ''}>${label}</a>`
              ).join('')}
              <a href="account.html" class="mobile-only" data-nav-account>My Account</a>
            </nav>
            <div class="header-actions" id="header-actions"></div>
            <button class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false"
                    aria-controls="primary-nav">
              <span></span><span></span><span></span>
            </button>
          </div>
        </header>`;

      document.getElementById('nav-toggle').addEventListener('click', (e) => {
        const open = document.body.classList.toggle('nav-open');
        e.currentTarget.setAttribute('aria-expanded', String(open));
      });

      if (document.body.classList.contains('transparent-header')) {
        const header = document.querySelector('.site-header');
        const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 40);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
      }
      renderHeaderActions();
    }

    const footerHost = document.getElementById('site-footer');
    if (footerHost) {
      const year = new Date().getFullYear();
      footerHost.outerHTML = `
        <footer class="site-footer">
          <div class="container">
            <div class="footer-grid">
              <div>
                <span class="brand-name">CORE</span>
                <span class="brand-sub">Pilates Studio</span>
                <p style="margin-top:1.2rem;max-width:26ch">
                  A supportive community focused on movement, strength and well-being.
                </p>
                <div class="social">
                  <a href="#" aria-label="Instagram">${icon('instagram')}</a>
                  <a href="#" aria-label="Facebook">${icon('facebook')}</a>
                  <a href="contact.html" aria-label="Email us">${icon('mail')}</a>
                </div>
              </div>
              <div>
                <h4>Quick Links</h4>
                <ul>
                  <li><a href="classes.html">Classes</a></li>
                  <li><a href="memberships.html">Memberships</a></li>
                  <li><a href="schedule.html">Schedule</a></li>
                  <li><a href="book.html">Book a Class</a></li>
                  <li><a href="account.html">My Account</a></li>
                </ul>
              </div>
              <div>
                <h4>Contact</h4>
                <ul>
                  <li>123 Wellness Way<br>Toronto, ON</li>
                  <li><a href="tel:+14161234567">(416) 123-4567</a></li>
                  <li><a href="mailto:hello@corepilates.com">hello@corepilates.com</a></li>
                </ul>
              </div>
              <div>
                <h4>Studio Hours</h4>
                <ul>
                  <li>Monday – Friday · 6am – 8pm</li>
                  <li>Saturday · 8am – 1pm</li>
                  <li>Sunday · 9am – 1pm</li>
                </ul>
                <a class="btn btn-sm" style="margin-top:1.2rem" href="book.html">Book a Class</a>
              </div>
            </div>
            <div class="footer-bottom">
              <span>© ${year} Core Pilates Studio. All rights reserved.</span>
              <span>Privacy Policy · Terms &amp; Conditions</span>
            </div>
          </div>
        </footer>`;
    }
  }

  function renderHeaderActions() {
    const host = document.getElementById('header-actions');
    if (!host) return;
    const signedIn = !!(state.me && state.me.user);
    host.innerHTML = signedIn
      ? `<a class="btn btn-ghost btn-sm" href="account.html">My Account</a>
         <a class="btn btn-sm" href="book.html">Book a Class</a>`
      : `<button class="btn btn-ghost btn-sm" data-login>Log In</button>
         <a class="btn btn-sm" href="book.html">Book a Class</a>`;

    const loginBtn = host.querySelector('[data-login]');
    if (loginBtn) loginBtn.addEventListener('click', () => openAuth('login'));

    document.querySelectorAll('[data-nav-account]').forEach((a) => {
      a.classList.toggle('hidden', !signedIn);
    });
  }

  // -------------------------------------------------------- auth modal

  let authResolve = null;

  function authMarkup(mode) {
    const isLogin = mode === 'login';
    return `
      <div class="modal-inner">
        <button class="modal-close" data-close aria-label="Close">&times;</button>
        <h2>${isLogin ? 'Welcome back' : 'Create your account'}</h2>
        <p class="modal-sub">${
          isLogin
            ? 'Log in to book classes and manage your membership.'
            : 'One account for bookings, memberships and payments.'
        }</p>
        <div class="form-error hidden" data-error></div>
        <form data-auth-form>
          ${
            isLogin
              ? ''
              : `<label class="field"><span>Full name</span>
                   <input name="name" autocomplete="name" required></label>`
          }
          <label class="field"><span>Email</span>
            <input name="email" type="email" autocomplete="email" required></label>
          <label class="field"><span>Password</span>
            <input name="password" type="password" minlength="8"
                   autocomplete="${isLogin ? 'current-password' : 'new-password'}" required></label>
          ${
            isLogin
              ? ''
              : `<label class="field"><span>Mobile (optional)</span>
                   <input name="phone" type="tel" autocomplete="tel"></label>
                 <p class="form-note">At least 8 characters. We never share your details.</p>`
          }
          <button class="btn btn-block" type="submit" style="margin-top:.6rem">
            ${isLogin ? 'Log In' : 'Create Account'}
          </button>
        </form>
        <p class="switch-line">
          ${isLogin ? 'New to the studio?' : 'Already a member?'}
          <button data-switch="${isLogin ? 'signup' : 'login'}">
            ${isLogin ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </div>`;
  }

  function openAuth(mode = 'login') {
    let backdrop = document.getElementById('auth-modal');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'auth-modal';
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = '<div class="modal"></div>';
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeAuth();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && backdrop.classList.contains('open')) closeAuth();
      });
    }

    const modal = backdrop.querySelector('.modal');
    modal.innerHTML = authMarkup(mode);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    const first = modal.querySelector('input');
    if (first) setTimeout(() => first.focus(), 120);

    modal.querySelector('[data-close]').addEventListener('click', closeAuth);
    modal.querySelector('[data-switch]').addEventListener('click', (e) => {
      openAuth(e.currentTarget.dataset.switch);
    });

    modal.querySelector('[data-auth-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const errorBox = modal.querySelector('[data-error]');
      const submit = form.querySelector('button[type=submit]');
      const original = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'One moment…';
      errorBox.classList.add('hidden');

      try {
        const body = Object.fromEntries(new FormData(form));
        const data = await post(mode === 'login' ? 'api/auth/login' : 'api/auth/signup', body);
        setMe(data);
        // Hand the session to whoever is waiting *before* closing — closeAuth
        // treats a still-pending resolver as the user backing out and settles
        // it with null, which would strand the caller mid-flow.
        const waiting = authResolve;
        authResolve = null;
        closeAuth();
        toast(mode === 'login' ? `Welcome back, ${data.user.name.split(' ')[0]}.` : 'Account created.', 'good');
        if (waiting) waiting(data);
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.classList.remove('hidden');
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    });
  }

  function closeAuth() {
    const backdrop = document.getElementById('auth-modal');
    if (backdrop) backdrop.classList.remove('open');
    if (authResolve) {
      authResolve(null);
      authResolve = null;
    }
  }

  /** Resolves with the session once signed in, or null if the user backs out. */
  function requireAuth(mode = 'login') {
    if (state.me && state.me.user) return Promise.resolve(state.me);
    return new Promise((resolve) => {
      authResolve = resolve;
      openAuth(mode);
    });
  }

  async function logout() {
    await post('api/auth/logout');
    setMe(null);
    toast('Logged out.');
  }

  // ----------------------------------------------------------- toasts

  function toast(message, kind = '') {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  // ------------------------------------------------------- formatting

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function parseDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
  }

  function formatTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m).padStart(2, '0')} ${period}`;
  }

  function formatDate(key, style = 'long') {
    const d = parseDate(key);
    if (style === 'short') return `${DOW[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
    return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function money(amount, currency = 'CAD') {
    return `$${Number(amount).toFixed(Number.isInteger(Number(amount)) ? 0 : 2)}`;
  }

  function relativeDay(key) {
    const today = dateKey(new Date());
    const tomorrow = dateKey(new Date(Date.now() + 864e5));
    if (key === today) return 'Today';
    if (key === tomorrow) return 'Tomorrow';
    return formatDate(key, 'short');
  }

  // ------------------------------------------------------ scroll reveal

  function watchReveals() {
    const items = document.querySelectorAll('.reveal:not(.in)');
    if (!items.length) return;
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (entry.isIntersecting) {
            setTimeout(() => entry.target.classList.add('in'), i * 70);
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px' }
    );
    items.forEach((el) => io.observe(el));
  }

  // ------------------------------------------------------------- boot

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderChrome();
    watchReveals();
    refresh().catch(() => setMe(null));
  });

  /**
   * When the site is running without a booking server, say so plainly at the
   * top of the page. It asks for a name, an email and card details; a visitor
   * is owed a clear statement that none of it reaches a studio.
   */
  function showDemoBanner() {
    if (document.getElementById('demo-banner')) return;
    if (sessionStorage.getItem('cp_demo_dismissed')) return;
    const bar = document.createElement('div');
    bar.id = 'demo-banner';
    bar.className = 'demo-banner';
    bar.innerHTML = `
      <span><strong>Demo site.</strong> Bookings, memberships and payments are simulated in
      your browser — no card is charged and no studio is contacted.</span>
      <button aria-label="Dismiss">&times;</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem('cp_demo_dismissed', '1');
      bar.remove();
      setBannerHeight(0);
    });
    document.body.prepend(bar);

    // The hero header is fixed, so it has to be pushed down by however tall the
    // banner actually is — which changes when the text wraps on a narrow screen.
    const measure = () => setBannerHeight(bar.offsetHeight);
    measure();
    window.addEventListener('resize', measure, { passive: true });
  }

  function setBannerHeight(px) {
    document.documentElement.style.setProperty('--banner-h', px + 'px');
  }

  // A render that dies mid-flow otherwise leaves a loading skeleton on screen
  // forever. Say so instead of pretending to still be working.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled error:', e.reason);
    toast((e.reason && e.reason.message) || 'Something went wrong. Please refresh.', 'bad');
  });

  return {
    api, get, post,
    state, onUserChange, refresh, config, setMe,
    requireAuth, openAuth, logout,
    toast, icon, escapeHtml, showDemoBanner,
    formatTime, formatDate, dateKey, parseDate, relativeDay, money,
    watchReveals,
    MONTHS, DOW,
  };
})();

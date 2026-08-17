/**
 * Accounts and sessions.
 *
 * Passwords are scrypt-hashed with a per-user salt. The session is a signed
 * cookie (HMAC-SHA256 over uid + expiry) rather than server state, so the
 * process can restart without logging everyone out. No third-party auth
 * dependency, no plaintext credential ever written to disk.
 */

const crypto = require('crypto');
const store = require('./store');

const SESSION_DAYS = 30;
const COOKIE = 'cp_session';

// ------------------------------------------------------------- passwords

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return attempt.length === known.length && crypto.timingSafeEqual(attempt, known);
}

// -------------------------------------------------------------- sessions

function secret() {
  return store.read().secret;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(userId) {
  const token = sign({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 });
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Returns the signed-in user record, or null. */
function currentUser(req) {
  const payload = unsign(parseCookies(req.headers.cookie)[COOKIE]);
  if (!payload) return null;
  return store.read().users.find((u) => u.id === payload.uid) || null;
}

// --------------------------------------------------------------- actions

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function signup({ name, email, password, phone }) {
  const clean = normaliseEmail(email);
  if (!name || !String(name).trim()) throw httpError(400, 'Please tell us your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw httpError(400, 'That email does not look right.');
  if (String(password || '').length < 8) throw httpError(400, 'Passwords need at least 8 characters.');

  return store.mutate((db) => {
    if (db.users.some((u) => u.email === clean)) {
      throw httpError(409, 'An account already uses that email. Try logging in.');
    }
    const user = {
      id: store.id('usr'),
      name: String(name).trim(),
      email: clean,
      phone: String(phone || '').trim(),
      password: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    return user;
  });
}

function login({ email, password }) {
  const clean = normaliseEmail(email);
  const user = store.read().users.find((u) => u.email === clean);
  if (!user || !verifyPassword(password, user.password)) {
    throw httpError(401, 'Email or password is incorrect.');
  }
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, phone: user.phone || '' };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  signup,
  login,
  currentUser,
  publicUser,
  sessionCookie,
  clearCookie,
  httpError,
};

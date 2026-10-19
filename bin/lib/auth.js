// auth.js — password login, session cookies, per-IP lockout.
//
// Public API routes (session/login/logout) live here; everything else in the
// server is gated behind isAuthed() by the dispatcher in bin/edlics.js.
//
// Sessions
// --------
// The cookie carries a 32-byte random token. The server keeps `sha256(token)`
// — never the token itself — in an in-memory map, and mirrors it to the
// `sessions` table when SQLite is open (--admin). Two clocks run together:
//
//   * idle TTL  — SESSION_TTL since the last request; **slides** on use, but
//                 the cookie is only re-issued at most every SESSION_REFRESH_MS
//                 (so we don't push a Set-Cookie header on every API call)
//   * absolute  — SESSION_MAX_LIFETIME since login; never slides, so a stolen
//                 token stops working eventually even if it keeps being used
//
// Restarting the server keeps sessions when the DB is open; without it the
// map is the only store and a restart logs everyone out (unit tests rely on
// that isolation).
const crypto = require('crypto');
const totp = require('./totp');

const DAY_MS = 24 * 3600 * 1000;
const SESSION_TTL = 7 * DAY_MS;            // idle timeout (sliding)
const SESSION_MAX_LIFETIME = 30 * DAY_MS;  // hard cap since login
const SESSION_REFRESH_MS = 60 * 1000;      // re-issue the cookie at most this often

let authPasswordHash = null; // sha256 Buffer (32 bytes) for timing-safe compare
const sessions = new Map();      // tokenHash (hex) -> { expires, seen, created, ip, ua }
const loginAttempts = new Map(); // in-memory fallback: ip -> { fails, lockedUntil }
const MAX_LOGIN_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
// Global circuit breaker: a burst of failures from many IPs (distributed
// brute force) trips a short cooldown for everyone. See ADMIN-PANEL-PLAN 0.3.
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_FAILS = 30;

// Optional persistence + audit hooks, injected by the server when SQLite is
// open (--admin). Without them the module keeps its original in-memory
// behaviour, so plain unit tests need no DB.
let attemptStore = null; // { get(ip), set(ip, {fails, lockedUntil}), del(ip) }
let sessionStore = null; // { all(), put(hash, row), del(hash), delExpired(now), prune(now) }
let hooks = { onLogin: null, onLoginFail: null, onLocked: null };
let cookieSecure = false;
let totpSecret = null;    // when set, login requires a valid TOTP code too

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
const hashToken = token => sha256(token).toString('hex');

/** Configure the login password (called once at startup). */
function setPassword(pw) { authPasswordHash = sha256(pw); }

/** Inject a synchronous store so lockouts survive restarts. */
function setAttemptStore(store) { attemptStore = store; }

/**
 * Inject a synchronous session store (SQLite). Rows are
 * `{ expires, seen, created, ip, ua }` keyed by the token **hash**.
 */
function setSessionStore(store) {
  sessionStore = store;
  if (!store) { sessions.clear(); return; }
  // Restore live sessions (drops anything already past its deadline).
  sessions.clear();
  const now = Date.now();
  for (const row of store.all()) {
    if (row.expires > now) sessions.set(row.hash, rowWith(row));
  }
  try { store.prune(now); } catch { /* best effort */ }
}

function rowWith(r) {
  return { expires: r.expires, seen: r.seen, created: r.created, ip: r.ip || '', ua: r.ua || '' };
}

/** Inject audit hooks (called with (ip, req) on login outcomes). */
function setHooks(h) { hooks = Object.assign(hooks, h); }
/** Add `Secure` to the session cookie (enable when served over TLS). */
function setCookieSecure(v) { cookieSecure = !!v; }

/** Require a TOTP second factor at login (null disables it). */
function setTotpSecret(s) { totpSecret = s || null; }
function totpEnabled() { return !!totpSecret; }

function getAttempt(ip) {
  return attemptStore ? attemptStore.get(ip) : loginAttempts.get(ip);
}
function setAttempt(ip, obj) {
  if (attemptStore) attemptStore.set(ip, obj); else loginAttempts.set(ip, obj);
}
function delAttempt(ip) {
  if (attemptStore) attemptStore.del(ip); else loginAttempts.delete(ip);
}

// Global failure timestamps (sliding window) for the circuit breaker.
let globalFails = [];
function globalTripped() {
  const now = Date.now();
  globalFails = globalFails.filter(t => now - t < GLOBAL_WINDOW_MS);
  return globalFails.length >= GLOBAL_MAX_FAILS;
}

/** Timing-safe password check against the configured password. */
function checkPassword(pw) {
  const given = sha256(pw || '');
  return !!(authPasswordHash && given.length === authPasswordHash.length &&
    crypto.timingSafeEqual(given, authPasswordHash));
}

/**
 * Parse a Cookie header into a plain object (values URI-decoded).
 * @param {{headers:{cookie?:string}}} req
 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, ttlMs) {
  return `edlics_session=${token}; HttpOnly${cookieSecure ? '; Secure' : ''}; SameSite=Strict; Path=/; ` +
    `Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}`;
}

/** Persist one session row (best effort — memory stays authoritative). */
function persist(hash, row) {
  if (sessionStore) { try { sessionStore.put(hash, row); } catch { /* best effort */ } }
}

/**
 * Validate the request's session token.
 *
 * Sliding renewal: every authenticated request pushes the idle deadline out,
 * and when the cookie has not been re-issued for SESSION_REFRESH_MS it gets a
 * fresh Max-Age. The absolute cap (created + SESSION_MAX_LIFETIME) is checked
 * first and never extended.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} [res]  when given, may re-issue the cookie
 * @returns {boolean}
 */
function isAuthed(req, res) {
  const token = parseCookies(req).edlics_session;
  if (!token) return false;
  const hash = hashToken(token);
  const row = sessions.get(hash);
  if (!row) return false;

  const now = Date.now();
  const hardStop = row.created + SESSION_MAX_LIFETIME;
  if (now >= row.expires || now >= hardStop) {
    sessions.delete(hash);
    if (sessionStore) { try { sessionStore.del(hash); } catch { /* best effort */ } }
    return false;
  }

  // Slide the idle window, but keep the cookie bounded by the absolute cap.
  const renewed = row.seen === 0 || now - row.seen >= SESSION_REFRESH_MS;
  row.seen = now;
  row.expires = Math.min(now + SESSION_TTL, hardStop);
  persist(hash, row);

  if (renewed && res && !res.headersSent) {
    res.setHeader('Set-Cookie', cookieHeader(token, row.expires - now));
  }
  return true;
}

/** Drop expired sessions from memory (and from the DB when one is attached). */
function pruneSessions() {
  const now = Date.now();
  for (const [hash, row] of sessions) {
    if (row.expires <= now || row.created + SESSION_MAX_LIFETIME <= now) {
      sessions.delete(hash);
      if (sessionStore) { try { sessionStore.del(hash); } catch { /* best effort */ } }
    }
  }
}

/** Delete every session (used by the reset helpers/tests). */
function clearSessions() {
  sessions.clear();
  if (sessionStore) { try { sessionStore.clear(); } catch { /* best effort */ } }
}

/**
 * Handle the three public auth routes. Returns true when the request was
 * matched and fully handled (ok/fail already sent the response).
 */
function handleAuthRoutes(parts, req, res, ok, fail) {
  if (parts[0] === 'api' && parts[1] === 'session') {
    ok({ authenticated: isAuthed(req, res), totp: totpEnabled() });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'login') {
    const ip = req._clientIp || req.socket.remoteAddress || 'unknown';
    if (globalTripped()) {
      if (hooks.onLocked) hooks.onLocked('global', ip, req);
      fail('Too many failed attempts. Try again later.', 429);
      return true;
    }
    const attempt = getAttempt(ip);
    if (attempt && attempt.lockedUntil > Date.now()) {
      if (hooks.onLocked) hooks.onLocked('ip', ip, req);
      fail('Too many failed attempts. Try again later.', 429);
      return true;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) { req.destroy(); } });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
      const passwordOk = checkPassword(data.password);
      const totpOk = !totpSecret || totp.verify(totpSecret, data.totp || '');
      if (!passwordOk || !totpOk) {
        globalFails.push(Date.now());
        const a = attempt || { fails: 0, lockedUntil: 0 };
        a.fails++;
        if (a.fails >= MAX_LOGIN_FAILS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.fails = 0; }
        setAttempt(ip, a);
        if (hooks.onLoginFail) hooks.onLoginFail(ip, req, passwordOk ? 'totp' : 'password');
        return fail('Wrong password' + (totpSecret && passwordOk ? ' or code' : ''), 401);
      }
      delAttempt(ip);
      pruneSessions();
      const token = crypto.randomBytes(32).toString('hex');
      const hash = hashToken(token);
      const now = Date.now();
      const row = {
        created: now, seen: now,
        expires: Math.min(now + SESSION_TTL, now + SESSION_MAX_LIFETIME),
        ip: req._clientIp || ip,
        ua: String(req.headers['user-agent'] || '').slice(0, 256),
      };
      sessions.set(hash, row);
      persist(hash, row);
      res.setHeader('Set-Cookie', cookieHeader(token, row.expires - now));
      if (hooks.onLogin) hooks.onLogin(ip, req);
      return ok({ ok: true });
    });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'logout') {
    const token = parseCookies(req).edlics_session;
    if (token) {
      const hash = hashToken(token);
      sessions.delete(hash);
      if (sessionStore) { try { sessionStore.del(hash); } catch { /* best effort */ } }
    }
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    ok({ ok: true });
    return true;
  }

  return false;
}

/** Drop expired sessions (exported for tests). */
function sessionCount() { return sessions.size; }

module.exports = {
  setPassword, checkPassword, parseCookies, isAuthed, pruneSessions,
  handleAuthRoutes, sha256, hashToken, sessionCount, clearSessions,
  SESSION_TTL, SESSION_MAX_LIFETIME, SESSION_REFRESH_MS,
  setAttemptStore, setSessionStore, setHooks, setCookieSecure, globalTripped,
  setTotpSecret, totpEnabled,
  MAX_LOGIN_FAILS, LOCKOUT_MS, GLOBAL_MAX_FAILS, GLOBAL_WINDOW_MS,
};

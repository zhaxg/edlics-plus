// auth.js — password login, session cookies, per-IP lockout.
//
// Public API routes (session/login/logout) live here; everything else in the
// server is gated behind isAuthed() by the dispatcher in bin/edlics.js.
const crypto = require('crypto');
const totp = require('./totp');

let authPasswordHash = null; // sha256 Buffer (32 bytes) for timing-safe compare
const sessions = new Map();      // token -> expiry epoch ms
const loginAttempts = new Map(); // in-memory fallback: ip -> { fails, lockedUntil }
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 days
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
let hooks = { onLogin: null, onLoginFail: null, onLocked: null };
let cookieSecure = false;
let totpSecret = null;    // when set, login requires a valid TOTP code too

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

/** Configure the login password (called once at startup). */
function setPassword(pw) { authPasswordHash = sha256(pw); }

/** Inject a synchronous store so lockouts survive restarts. */
function setAttemptStore(store) { attemptStore = store; }
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

function isAuthed(req) {
  const token = parseCookies(req).edlics_session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function pruneSessions() {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}

/**
 * Handle the three public auth routes. Returns true when the request was
 * matched and fully handled (ok/fail already sent the response).
 */
function handleAuthRoutes(parts, req, res, ok, fail) {
  if (parts[0] === 'api' && parts[1] === 'session') {
    ok({ authenticated: isAuthed(req), totp: totpEnabled() });
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
      sessions.set(token, Date.now() + SESSION_TTL);
      res.setHeader('Set-Cookie',
        `edlics_session=${token}; HttpOnly${cookieSecure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
      if (hooks.onLogin) hooks.onLogin(ip, req);
      return ok({ ok: true });
    });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'logout') {
    const token = parseCookies(req).edlics_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'edlics_session=; HttpOnly; Path=/; Max-Age=0');
    ok({ ok: true });
    return true;
  }

  return false;
}

/** Drop expired sessions (exported for tests). */
function sessionCount() { return sessions.size; }

module.exports = {
  setPassword, checkPassword, parseCookies, isAuthed, pruneSessions,
  handleAuthRoutes, sha256, sessionCount, SESSION_TTL,
  setAttemptStore, setHooks, setCookieSecure, globalTripped,
  setTotpSecret, totpEnabled,
  MAX_LOGIN_FAILS, LOCKOUT_MS, GLOBAL_MAX_FAILS, GLOBAL_WINDOW_MS,
};

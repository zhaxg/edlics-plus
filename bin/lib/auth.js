// auth.js — password login, session cookies, per-IP lockout.
//
// Public API routes (session/login/logout) live here; everything else in the
// server is gated behind isAuthed() by the dispatcher in bin/edlics.js.
const crypto = require('crypto');

let authPasswordHash = null; // sha256 Buffer (32 bytes) for timing-safe compare
const sessions = new Map();      // token -> expiry epoch ms
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 days
const MAX_LOGIN_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

/** Configure the login password (called once at startup). */
function setPassword(pw) { authPasswordHash = sha256(pw); }

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
    ok({ authenticated: isAuthed(req) });
    return true;
  }

  if (parts[0] === 'api' && parts[1] === 'login') {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.lockedUntil > Date.now()) {
      fail('Too many failed attempts. Try again later.', 429);
      return true;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) { req.destroy(); } });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
      if (!checkPassword(data.password)) {
        const a = attempt || { fails: 0, lockedUntil: 0 };
        a.fails++;
        if (a.fails >= MAX_LOGIN_FAILS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.fails = 0; }
        loginAttempts.set(ip, a);
        return fail('Wrong password', 401);
      }
      loginAttempts.delete(ip);
      pruneSessions();
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      res.setHeader('Set-Cookie', `edlics_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
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
};

// Sessions: sliding idle TTL, absolute cap, SQLite persistence across restart.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('../bin/lib/auth');
const db = require('../bin/lib/db');

const DAY = 24 * 3600 * 1000;

/** Minimal in-memory clone of the SQLite session store. */
function memoryStore(rows = new Map()) {
  return {
    rows,
    all() { return [...rows.entries()].map(([hash, r]) => ({ hash, ...r })); },
    put(hash, row) { rows.set(hash, { ...row }); },
    del(hash) { rows.delete(hash); },
    prune() {},
    clear() { rows.clear(); },
  };
}

/** Fake req/res for the auth module. */
function reqWith(token) {
  return { headers: { cookie: `edlics_session=${token}`, 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' }, _clientIp: '127.0.0.1' };
}
function fakeRes() {
  return { headersSent: false, cookie: null, setHeader(k, v) { if (k === 'Set-Cookie') this.cookie = v; } };
}

/** Run a successful login and return { token, cookie }. */
function login() {
  return new Promise((resolve) => {
    const req = {
      headers: { 'user-agent': 'test' },
      socket: { remoteAddress: '10.1.2.3' },
      _clientIp: '10.1.2.3',
      on(ev, fn) {
        if (ev === 'data') fn(JSON.stringify({ password: 'pw-for-tests' }));
        if (ev === 'end') fn();
      },
    };
    const res = fakeRes();
    auth.handleAuthRoutes(['api', 'login'], req, res,
      data => {
        const token = /edlics_session=([0-9a-f]+)/.exec(res.cookie)[1];
        resolve({ token, cookie: res.cookie, data });
      },
      (msg, code) => { throw new Error(`login failed: ${msg} (${code})`); });
  });
}

beforeEach(() => {
  auth.setPassword('pw-for-tests');
  auth.setSessionStore(null);
  auth.clearSessions();
});

afterEach(() => {
  auth.setSessionStore(null);
  auth.clearSessions();
  db.close();
});

test('isAuthed: login token works, forged token does not', async () => {
  const { token } = await login();
  assert.strictEqual(auth.isAuthed(reqWith(token)), true);
  assert.strictEqual(auth.isAuthed(reqWith('deadbeef')), false);
  assert.strictEqual(auth.isAuthed(reqWith(token.slice(0, -1) + 'f')), false);
});

test('cookie carries HttpOnly + SameSite=Strict and the idle TTL', async () => {
  const { cookie } = await login();
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, new RegExp(`Max-Age=${Math.floor(auth.SESSION_TTL / 1000)}`));
  assert.doesNotMatch(cookie, /Secure/, 'Secure is opt-in via --cookie-secure');
});

test('sliding renewal: each request pushes the idle deadline out', async () => {
  const { token } = await login();
  const res = fakeRes();
  assert.ok(auth.isAuthed(reqWith(token), res));
  // Within the refresh window the cookie is not re-issued...
  const res2 = fakeRes();
  assert.ok(auth.isAuthed(reqWith(token), res2));
  assert.strictEqual(res2.cookie, null, 'no Set-Cookie on every request');

  // ...but the deadline moved: step just past the original TTL, then touch
  // the session again (which slides it from *now*), and it is still valid.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + auth.SESSION_TTL - 60 * 1000;
    assert.ok(auth.isAuthed(reqWith(token), fakeRes()), 'valid just before the TTL');
    Date.now = () => realNow() + auth.SESSION_TTL + 60 * 1000;
    assert.ok(auth.isAuthed(reqWith(token), fakeRes()), 'idle TTL must have slid');
  } finally { Date.now = realNow; }
});

test('absolute cap: a continuously used session still expires', async () => {
  const { token } = await login();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + auth.SESSION_MAX_LIFETIME + 1000;
    assert.strictEqual(auth.isAuthed(reqWith(token), fakeRes()), false);
  } finally { Date.now = realNow; }
});

test('expired session is rejected and pruned', async () => {
  const { token } = await login();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + auth.SESSION_TTL + 60 * 1000;
    assert.strictEqual(auth.isAuthed(reqWith(token)), false);
  } finally { Date.now = realNow; }
  auth.pruneSessions();
  assert.strictEqual(auth.sessionCount(), 0);
});

test('logout deletes the server-side session', async () => {
  const { token } = await login();
  assert.strictEqual(auth.sessionCount(), 1);
  auth.handleAuthRoutes(['api', 'logout'], reqWith(token), fakeRes(), () => {}, () => {});
  assert.strictEqual(auth.isAuthed(reqWith(token)), false);
});

test('store keeps only token hashes, never the token', async () => {
  const store = memoryStore();
  auth.setSessionStore(store);
  const { token } = await login();
  const stored = [...store.rows.keys()];
  assert.strictEqual(stored.length, 1);
  assert.match(stored[0], /^[0-9a-f]{64}$/);
  assert.notStrictEqual(stored[0], token);
  assert.strictEqual(stored[0], auth.hashToken(token));
  assert.ok(!JSON.stringify([...store.rows.values()]).includes(token));
});

test('sessions survive a restart through the SQLite store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-session-'));
  try {
    db.open(path.join(dir, 'edlics.db'));
    const store = {
      all: () => db.getDb().prepare('SELECT token_hash AS hash, created, seen, expires, ip, ua FROM sessions').all(),
      put: (hash, r) => db.getDb().prepare(
        'INSERT INTO sessions (token_hash, created, seen, expires, ip, ua) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(token_hash) DO UPDATE SET seen = excluded.seen, expires = excluded.expires'
      ).run(hash, r.created, r.seen, r.expires, r.ip || null, r.ua || null),
      del: hash => db.getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash),
      prune: now => db.getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(now),
      clear: () => db.getDb().prepare('DELETE FROM sessions').run(),
    };
    auth.setSessionStore(store);
    const { token } = await login();
    assert.strictEqual(auth.isAuthed(reqWith(token)), true);

    // Simulate a restart: memory is lost, the DB file is not.
    auth.setSessionStore(null);                 // detach (wipes memory only)
    assert.strictEqual(auth.sessionCount(), 0, 'memory emptied by the restart');
    db.close();
    db.open(path.join(dir, 'edlics.db'));
    auth.setSessionStore(store);                // boot: reload from disk
    assert.strictEqual(auth.isAuthed(reqWith(token)), true, 'login must survive a restart');

    // A logout before the restart must not come back.
    const other = await login();
    auth.handleAuthRoutes(['api', 'logout'], reqWith(other.token), fakeRes(), () => {}, () => {});
    auth.setSessionStore(null);
    auth.setSessionStore(store);
    assert.strictEqual(auth.isAuthed(reqWith(other.token)), false, 'logged-out session stays gone');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoring drops rows that already expired', async () => {
  const store = memoryStore();
  auth.setSessionStore(store);
  await login();
  const hash = [...store.rows.keys()][0];
  store.rows.set(hash, { ...store.rows.get(hash), expires: Date.now() - 1000 });

  auth.setSessionStore(store);                  // reload
  assert.strictEqual(auth.sessionCount(), 0);
});

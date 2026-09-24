// terminal-api.js — one real TTY shell per logged-in session (node-pty,
// wede-style): the shell itself does echo/line-editing/tab-stops over the
// PTY; the browser only passes raw keystrokes through.
//
// Idle policy: a session with no I/O for TERM_IDLE_MS is killed so shells
// don't outlive the browser tab forever (see CLAUDE.md).
const fs = require('fs');
const { parseCookies } = require('./auth');
const { getRootDir, isPathSafe } = require('./paths');

/**
 * @typedef {Object} TermSession
 * @property {{kill: Function, write: Function, resize: Function,
 *   onData: Function, onExit: Function}} pty
 * @property {Array<Uint8Array|string>} parts  replay buffer (capped)
 * @property {number} len                      current buffer byte length
 * @property {import('http').ServerResponse|null} stream attached viewer
 * @property {boolean} exited
 * @property {string} cwd
 * @property {number} lastActivity              epoch ms of last I/O
 */

const TERM_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const termSessions = new Map();      // session token -> TermSession

let _pty = null;
function getPty() {
  if (!_pty) _pty = require('node-pty');
  return _pty;
}
function termKey(req) { return parseCookies(req).edlics_session || 'anon'; }

process.on('exit', () => {
  for (const s of termSessions.values()) { try { s.pty.kill(); } catch {} }
});

/**
 * Kill sessions idle longer than TERM_IDLE_MS (exported for unit tests).
 * @param {number} now epoch ms
 */
function sweepIdle(now = Date.now()) {
  for (const [key, sess] of termSessions) {
    if (sess.exited) { termSessions.delete(key); continue; }
    if (now - (sess.lastActivity || 0) > TERM_IDLE_MS) {
      if (sess.stream && !sess.stream.writableEnded) {
        try {
          sess.stream.write('\r\n[idle: terminal session closed after 30 minutes of inactivity]\r\n');
          sess.stream.end();
        } catch {}
      }
      try { sess.pty.kill(); } catch {}
      termSessions.delete(key);
    }
  }
}
setInterval(() => sweepIdle(), 60 * 1000).unref();

function termBufAppend(sess, data) {
  sess.parts.push(data);
  sess.len += data.length;
  while (sess.len > 256 * 1024 && sess.parts.length > 1) sess.len -= sess.parts.shift().length;
}

function readJsonBody(req, cb, max = 64 * 1024) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => {
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch { return cb(null); }
    cb(data);
  });
}

function handleOpen(ctx) {
  const { req, ok, fail } = ctx;
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const key = termKey(req);
    const existing = termSessions.get(key);
    if (existing) {
      if (existing.stream && !existing.stream.writableEnded) { try { existing.stream.end(); } catch {} }
      try { existing.pty.kill(); } catch {}
      termSessions.delete(key);
    }

    const root = getRootDir();
    let cwd = data.cwd || root || process.cwd();
    if (!isPathSafe(cwd)) return fail('Access denied: path outside root directory', 403);
    try { if (!fs.statSync(cwd).isDirectory()) cwd = root || process.cwd(); }
    catch { cwd = root || process.cwd(); }

    const cols = Math.min(500, Math.max(20, parseInt(data.cols) || 80));
    const rows = Math.min(200, Math.max(5, parseInt(data.rows) || 24));
    const isWin = process.platform === 'win32';
    const file = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');

    let pty;
    try {
      pty = getPty().spawn(file, [], {
        name: 'xterm-256color', cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) { return fail('Failed to start shell: ' + e.message, 500); }

    const sess = { pty, parts: [], len: 0, stream: null, exited: false, cwd, lastActivity: Date.now() };
    termSessions.set(key, sess);
    pty.onData(d => {
      sess.lastActivity = Date.now();
      termBufAppend(sess, d);
      if (sess.stream && !sess.stream.writableEnded) sess.stream.write(d);
    });
    pty.onExit(() => {
      sess.exited = true;
      if (termSessions.get(key) === sess) termSessions.delete(key);
      if (sess.stream && !sess.stream.writableEnded) {
        try { sess.stream.write('\r\n[process exited]\r\n'); sess.stream.end(); } catch {}
      }
    });
    return ok({ ok: true, cwd });
  });
}

function handleStream(ctx) {
  const { req, res, fail } = ctx;
  const sess = termSessions.get(termKey(req));
  if (!sess || sess.exited) return fail('No terminal session', 410);
  // Single viewer: a new stream takes over from any previous one
  if (sess.stream && !sess.stream.writableEnded) { try { sess.stream.end(); } catch {} }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  for (const chunk of sess.parts) res.write(chunk);
  sess.stream = res;
  res.on('close', () => { if (sess.stream === res) sess.stream = null; });
  // stays open, fed by pty.onData
}

function handleInput(ctx) {
  const { req, ok, fail } = ctx;
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const sess = termSessions.get(termKey(req));
    if (!sess || sess.exited) return fail('No terminal session', 410);
    if (typeof data.data === 'string' && data.data) {
      sess.lastActivity = Date.now();
      try { sess.pty.write(data.data); } catch {}
    }
    return ok({ ok: true });
  });
}

function handleResize(ctx) {
  const { req, ok, fail } = ctx;
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const sess = termSessions.get(termKey(req));
    if (!sess || sess.exited) return fail('No terminal session', 410);
    const cols = Math.min(500, Math.max(20, parseInt(data.cols) || 80));
    const rows = Math.min(200, Math.max(5, parseInt(data.rows) || 24));
    try { sess.pty.resize(cols, rows); } catch {}
    return ok({ ok: true });
  }, 1024);
}

function handleClose(ctx) {
  const { req, ok } = ctx;
  const key = termKey(req);
  const sess = termSessions.get(key);
  if (sess) {
    if (sess.stream && !sess.stream.writableEnded) { try { sess.stream.end(); } catch {} }
    try { sess.pty.kill(); } catch {}
    termSessions.delete(key);
  }
  return ok({ ok: true });
}

/** Route table — see CLAUDE.md. */
const routes = [
  { name: 'api/term/open',    match: p => p[1] === 'term' && p[2] === 'open',    handle: handleOpen },
  { name: 'api/term/stream',  match: p => p[1] === 'term' && p[2] === 'stream',  handle: handleStream },
  { name: 'api/term/input',   match: p => p[1] === 'term' && p[2] === 'input',   handle: handleInput },
  { name: 'api/term/resize',  match: p => p[1] === 'term' && p[2] === 'resize',  handle: handleResize },
  { name: 'api/term/close',   match: p => p[1] === 'term' && p[2] === 'close',   handle: handleClose },
];

module.exports = { routes, sweepIdle, termSessions, TERM_IDLE_MS };

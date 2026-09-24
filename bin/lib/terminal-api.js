// terminal-api.js — one real TTY shell per logged-in session (node-pty,
// wede-style): the shell itself does echo/line-editing/tab-stops over the
// PTY; the browser only passes raw keystrokes through.
//
// Idle policy: a session with no I/O for TERM_IDLE_MS is killed so shells
// don't outlive the browser tab forever (see CLAUDE.md).
const fs = require('fs');
const { parseCookies } = require('./auth');
const { getRootDir, isPathSafe, toPosix } = require('./paths');

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

// --- Input policy (anti foot-cannon, NOT an anti-hacker boundary) ---
// 1) multi-line payloads are rejected outright (nothing reaches the shell)
// 2) at Enter time the composed line is checked against HIGH_RISK_RULES;
//    a match withholds the \\r and sends ^C so the shell discards the line.
// Line tracking is best-effort (printables + backspace + arrows); its job is
// catching fat-fingered disasters, not stopping a determined attacker.

const HIGH_RISK_RULES = [
  ['force-delete of / or ~ or * (rm -rf …)', /^(?:\s|sudo\s+)*rm\s+(?:-[a-z]+\s+)*-[a-z]*[rf][a-z]*\s+(?:--\s+)?["']?(?:\/\*|~\/\*|\/|~|\*|C:\\\\)(?:["']?)(?=\s|$)/i],
  ['disk format (mkfs…)', /^(?:\s|sudo\s+)*mkfs(\.\w+)?\b/i],
  ['raw write to a disk device (dd of=/dev/…)', /\bdd\b[^\n]*\bof=\/dev\/(sd|hd|nvme|disk)/i],
  ['direct write to a block device (> /dev/…)', /(^|[^>])>\s*\/dev\/(sd|hd|nvme|disk)[a-z0-9]*\s/i],
  ['fork bomb', /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&/],
  ['shutdown/reboot/halt/poweroff', /^\s*(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff)(?=\s|$)/i],
  ['runlevel 0/6 (init …)', /^\s*(?:sudo\s+)?init\s+[06]\s*$/i],
  ['Windows: format a drive', /^\s*format\s+[a-zA-Z]:(?=\s|$)/i],
  ['Windows: recursive delete of a drive root', /^\s*(?:rd|rmdir)\s+\/s\s+\/q\s+["']?[a-zA-Z]:\\?["']?\s*$/i],
  ['Windows: recursive force delete via del', /^\s*del\s+[^\n]*\/[a-z]*[fs][a-z]*[^\n]*[a-zA-Z]:\\?\*(?=\s|$)/i],
  ['chmod -R 777 /', /^\s*(?:sudo\s+)?chmod\s+-[a-z]*R[a-z]*\s+777\s+["']?\/["']?\s*$/i],
];

/**
 * Check a submitted line against the hard denylist.
 * @param {string} line
 * @returns {string|null} matched rule label, or null when allowed
 */
function checkHighRisk(line) {
  for (const [label, re] of HIGH_RISK_RULES) if (re.test(line)) return label;
  return null;
}

/**
 * Classify one client input payload.
 * - reject: payload carries more than one logical line (multi-line not supported)
 * - pass:   forward `body`, then (if `term`) the terminator — the high-risk
 *           check runs on the tracked line before the terminator is forwarded
 * @param {string} data
 * @returns {{action:'pass'|'reject', body:string, term:string}}
 */
function classifyInput(data) {
  const str = String(data || '');
  const segs = str.split(/[\r\n]+/).filter(s => s !== '');
  if (segs.length > 1) return { action: 'reject', body: '', term: '' };
  const ti = str.search(/[\r\n]/);
  if (ti === -1) return { action: 'pass', body: str, term: '' };
  return { action: 'pass', body: str.slice(0, ti), term: str.slice(ti) };
}

/**
 * Best-effort mirror of the shell's line buffer so Enter-time checks see the
 * text the user actually has on screen (printables, backspace, arrow-history).
 * @param {string} buf    current tracked line
 * @param {string} body   forwarded payload without terminator
 * @param {string} lastSubmit last successfully submitted line (for ↑)
 * @returns {string}
 */
function trackLine(buf, body, lastSubmit) {
  let out = buf;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\x7f' || ch === '\b') { out = out.slice(0, -1); continue; }
    if (ch === '\x03' || ch === '\x04' || ch === '\x1a') { out = ''; continue; }
    if (ch === '\x1b') {
      const m = body.slice(i).match(/^\x1b(?:\[[0-9;?]*[A-Za-z]|\.[A-Za-z]|O[P-QX-Z])/);
      if (m) {
        if (m[0] === '\x1b[A' && lastSubmit) out = lastSubmit;
        else if (m[0] === '\x1b[B') out = '';
        i += m[0].length - 1;
      }
      continue; // never buffer raw ESC
    }
    if (ch >= ' ') out += ch;
  }
  return out;
}

/** Display-only note injected into the PTY stream (never enters the shell). */
function streamNote(sess, msg) {
  if (sess.stream && !sess.stream.writableEnded) {
    try { sess.stream.write('\r\n\x1b[33m[edlics] ' + msg + '\x1b[0m\r\n'); } catch {}
  }
}

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

    const sess = { pty, parts: [], len: 0, stream: null, exited: false, cwd, lastActivity: Date.now(), lineBuf: '', lastSubmit: '' };
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
    return ok({ ok: true, cwd: toPosix(cwd) });
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
    const raw = data.data;
    if (typeof raw !== 'string' || !raw) return ok({ ok: true });

    const cls = classifyInput(raw);
    if (cls.action === 'reject') {
      streamNote(sess, 'multi-line input is not supported — nothing was executed');
      return ok({ ok: true, rejected: 'multiline' });
    }
    sess.lastActivity = Date.now();
    if (cls.body) {
      sess.lineBuf = trackLine(sess.lineBuf || '', cls.body, sess.lastSubmit || '');
      try { sess.pty.write(cls.body); } catch {}
    }
    if (cls.term) {
      const line = (sess.lineBuf || '').trim();
      const risk = line ? checkHighRisk(line) : null;
      if (risk) {
        // Withhold the Enter and tell the shell to discard its pending line
        try { sess.pty.write('\x03'); } catch {}
        streamNote(sess, `blocked by safety policy (${risk}) — not executed: ${line.slice(0, 80)}`);
        sess.lineBuf = '';
        return ok({ ok: true, blocked: risk });
      }
      sess.lastSubmit = sess.lineBuf || '';
      sess.lineBuf = '';
      try { sess.pty.write(cls.term); } catch {}
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

module.exports = {
  routes, sweepIdle, termSessions, TERM_IDLE_MS,
  classifyInput, checkHighRisk, trackLine,
};

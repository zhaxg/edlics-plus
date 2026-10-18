// processes-api.js — process list (top-style) and signalling.
//
// Samples /proc/<pid>/{stat,cmdline} plus the owner uid, and derives CPU% from
// the delta between two samples (like top). Kill is gated behind --admin-write
// with a signal allowlist and audited; PID 1 and our own PID are refused.
const fs = require('fs');
const os = require('os');
const audit = require('./audit');

const PAGE_SIZE = 4096;   // standard on x86_64/arm64 Linux
const HZ = 100;           // USER_HZ (CLK_TCK) — 100 on Linux by convention
const MAX_LIMIT = 500;
const SIGNALS = new Set(['TERM', 'KILL', 'HUP', 'INT', 'QUIT', 'STOP', 'CONT', 'USR1', 'USR2', 'ABRT']);

const STATE = { R: 'running', S: 'sleep', D: 'disk', Z: 'zombie', T: 'stopped', t: 'tracing', I: 'idle', X: 'dead' };

// --- pure parsers (exported for tests) -------------------------------------

/**
 * Parse /proc/<pid>/stat. `comm` may contain spaces and parentheses, so the
 * field boundary is found from the LAST ')'. Pure; tested.
 * @returns {{pid:number,comm:string,state:string,ppid:number,utime:number,
 *   stime:number,threads:number,starttime:number,vsize:number,rss:number}|null}
 */
function parseProcStat(text) {
  const s = String(text || '');
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const pid = parseInt(s.slice(0, open), 10);
  const comm = s.slice(open + 1, close);
  const r = s.slice(close + 2).trim().split(/\s+/);
  if (r.length < 22) return null;
  return {
    pid, comm,
    state: r[0],
    ppid: parseInt(r[1], 10),
    utime: parseInt(r[11], 10) || 0,
    stime: parseInt(r[12], 10) || 0,
    threads: parseInt(r[17], 10) || 1,
    starttime: parseInt(r[19], 10) || 0,
    vsize: parseInt(r[20], 10) || 0,
    rss: parseInt(r[21], 10) || 0, // pages
  };
}

/** Total jiffies from the first "cpu" line of /proc/stat. Pure; tested. */
function parseCpuTotal(statText) {
  const first = String(statText || '').split('\n')[0].trim();
  if (!first.startsWith('cpu')) return 0;
  return first.split(/\s+/).slice(1).reduce((a, x) => a + (parseInt(x, 10) || 0), 0);
}

/**
 * CPU% from two (utime+stime) snapshots and the machine-wide jiffy delta.
 * Pure; tested.
 */
function computeProcCpu(prevTicks, curTicks, totalDelta) {
  if (totalDelta <= 0 || curTicks == null || prevTicks == null) return 0;
  return Math.max(0, (100 * (curTicks - prevTicks)) / totalDelta);
}

/** uid → username from a parsed /etc/passwd (Map), or the numeric uid. */
function userForUid(uid, passwdMap) {
  return passwdMap.get(uid) || String(uid);
}

function parsePasswdMap(text) {
  const m = new Map();
  for (const line of String(text || '').split('\n')) {
    const f = line.split(':');
    if (f.length >= 3) m.set(parseInt(f[2], 10), f[0]);
  }
  return m;
}

// --- sampling --------------------------------------------------------------

let prev = new Map();   // pid -> ticks (utime+stime)
let prevTotal = 0;
let passwdCache = { at: 0, map: new Map() };

function passwdMap() {
  if (Date.now() - passwdCache.at > 60000) {
    try { passwdCache = { at: Date.now(), map: parsePasswdMap(fs.readFileSync('/etc/passwd', 'utf-8')) }; }
    catch { passwdCache.at = Date.now(); }
  }
  return passwdCache.map;
}

function readCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const cmd = raw.replace(/\0/g, ' ').trim();
    return cmd;
  } catch { return ''; }
}

/**
 * One pass over /proc. CPU% is relative to the whole machine (0–100).
 * @returns {{processes:object[], total:number, load:number[], cores:number, memTotal:number}}
 */
function sampleProcesses() {
  const statText = (() => { try { return fs.readFileSync('/proc/stat', 'utf-8'); } catch { return ''; } })();
  const total = parseCpuTotal(statText);
  const totalDelta = prevTotal ? Math.max(1, total - prevTotal) : 0;
  const memTotal = os.totalmem();
  const users = passwdMap();
  const now = Date.now();

  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { pids = []; }

  const next = new Map();
  const processes = [];
  for (const name of pids) {
    const pid = parseInt(name, 10);
    let st;
    try { st = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8'); } catch { continue; }
    const p = parseProcStat(st);
    if (!p) continue;
    const ticks = p.utime + p.stime;
    next.set(pid, ticks);
    const cpu = computeProcCpu(prev.get(pid), ticks, totalDelta);
    let uid = 0;
    try { uid = fs.statSync(`/proc/${pid}`).uid; } catch {}
    const rssBytes = p.rss * PAGE_SIZE;
    processes.push({
      pid: p.pid,
      ppid: p.ppid,
      user: userForUid(uid, users),
      name: p.comm,
      state: p.state,
      stateLabel: STATE[p.state] || p.state,
      cpu: Math.round(cpu * 10) / 10,
      mem: memTotal ? Math.round((rssBytes / memTotal) * 1000) / 10 : 0,
      rss: rssBytes,
      vsz: p.vsize,
      threads: p.threads,
      time: Math.round(ticks / HZ),                 // seconds of CPU time
      elapsed: Math.max(0, Math.round(os.uptime() - p.starttime / HZ)),
      cmd: readCmdline(pid) || `[${p.comm}]`,
    });
  }
  prev = next;
  prevTotal = total;
  return { processes, total: processes.length, load: os.loadavg().map(n => Math.round(n * 100) / 100), cores: os.cpus().length, memTotal };
}

// --- handlers --------------------------------------------------------------

function handleList(ctx) {
  const { params, ok, fail } = ctx;
  try {
    const snap = sampleProcesses();
    const sort = params.sort || 'cpu';
    const cmp = sort === 'mem' ? (a, b) => b.mem - a.mem || b.rss - a.rss
      : sort === 'pid' ? (a, b) => a.pid - b.pid
      : (a, b) => b.cpu - a.cpu || b.mem - a.mem;
    const q = (params.q || '').toLowerCase();
    let list = snap.processes;
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) || String(p.pid) === q);
    list = list.sort(cmp);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(params.limit, 10) || 100));
    ok({ processes: list.slice(0, limit), total: snap.total, load: snap.load, cores: snap.cores, memTotal: snap.memTotal, sort });
  } catch (e) { fail(e.message); }
}

function readJsonBody(req, cb, max = 4096) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

function handleKill(ctx) {
  const { req, ok, fail, adminWrite, readonly, clientIp } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Signalling processes requires --admin-write', 403);
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const pid = parseInt(data.pid, 10);
    const signal = String(data.signal || 'TERM').toUpperCase().replace(/^SIG/, '');
    if (!Number.isInteger(pid) || pid <= 1) return fail('Refusing to signal PID 1 or invalid PID', 400);
    if (pid === process.pid) return fail('Refusing to signal the panel process itself', 400);
    const sigNum = os.constants.signals['SIG' + signal];
    if (!SIGNALS.has(signal) || !sigNum) return fail('Unsupported signal', 400);
    const ip = clientIp || req.socket.remoteAddress || 'unknown';
    try {
      process.kill(pid, sigNum);
      audit.log('process.signal', { ip, ua: req.headers['user-agent'] || '', target: `${pid}:${signal}`, result: 'ok' });
      ok({ ok: true, pid, signal });
    } catch (e) {
      audit.log('process.signal', { ip, ua: req.headers['user-agent'] || '', target: `${pid}:${signal}`, result: 'fail: ' + e.message });
      fail('signal failed: ' + e.message);
    }
  });
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/processes',      match: p => p[1] === 'sys' && p[2] === 'processes' && !p[3],      handle: handleList },
  { name: 'api/sys/processes/kill', match: p => p[1] === 'sys' && p[2] === 'processes' && p[3] === 'kill', handle: handleKill },
];

module.exports = {
  routes, parseProcStat, parseCpuTotal, computeProcCpu, parsePasswdMap,
  sampleProcesses, SIGNALS, MAX_LIMIT,
};

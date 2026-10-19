// sys-api.js — whole-system endpoints: info, live metrics (SSE), metric
// history, health, audit. ALL of it is gated behind --admin by the dispatcher
// (bin/edlics.js), and every mutation-style action is audited.
//
// Invariants (docs/ADMIN-PANEL-PLAN.md):
//   * ONE sampler, N subscribers — metrics.js owns the sampling cadence.
//   * Bounded clients / bounded responses.
//   * Pure parsers where possible (parseOsRelease) for unit tests.
const fs = require('fs');
const os = require('os');
const { performance } = require('perf_hooks');
const metrics = require('./metrics');
const audit = require('./audit');
const auth = require('./auth');
const totp = require('./totp');
const { getDb, isOpen } = require('./db');
const { VERSION } = require('./version');

const MAX_SSE_CLIENTS = 50;
const DEFAULT_RETENTION_DAYS = 30;
const HISTORY_MAX_POINTS = 1200;

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();
let keepAliveTimer = null;
let retentionTimer = null;

// --- /etc/os-release -------------------------------------------------------

/** Parse /etc/os-release into a plain map (quotes stripped). Pure; tested. */
function parseOsRelease(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function osPrettyName() {
  try {
    const rel = parseOsRelease(fs.readFileSync('/etc/os-release', 'utf-8'));
    return rel.PRETTY_NAME || rel.NAME || os.type();
  } catch { return os.type(); }
}

function cpuModel() {
  try {
    const m = fs.readFileSync('/proc/cpuinfo', 'utf-8').match(/^model name\s*:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// --- event-loop health -----------------------------------------------------

let loopMonitor = null;
function loopDelayMs() {
  try {
    const { monitorEventLoopDelay } = require('perf_hooks');
    if (!loopMonitor) { loopMonitor = monitorEventLoopDelay({ resolution: 20 }); loopMonitor.enable(); }
    const mean = loopMonitor.mean, max = loopMonitor.max;
    return {
      // NaN before the first sampling interval → 0 so JSON never emits null
      mean: Number.isFinite(mean) ? Number((mean / 1e6).toFixed(2)) : 0,
      max: Number.isFinite(max) ? Number((max / 1e6).toFixed(2)) : 0,
    };
  } catch { return { mean: 0, max: 0 }; }
}

// --- handlers --------------------------------------------------------------

/** Primary non-internal IPv4 address, or 127.0.0.1. */
function primaryIp() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
  } catch { /* ignore */ }
  return '127.0.0.1';
}

/** Memory/swap bytes from /proc/meminfo. */
function memSummary() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf-8');
    const get = (k) => { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(txt); return m ? Number(m[1]) * 1024 : 0; };
    const swapTotal = get('SwapTotal'), swapFree = get('SwapFree');
    return { swapTotal, swapUsed: Math.max(0, swapTotal - swapFree), memAvailable: get('MemAvailable') };
  } catch { return { swapTotal: 0, swapUsed: 0, memAvailable: 0 }; }
}

function handleInfo(ctx) {
  const { ok } = ctx;
  const cpus = os.cpus() || [];
  const mem = memSummary();
  ok({
    hostname: os.hostname(),
    os: osPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    platform: process.platform,
    uptime: Math.round(os.uptime()),
    cpuModel: cpuModel(),
    cores: cpus.length,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    memAvailable: mem.memAvailable,
    swapTotal: mem.swapTotal,
    swapUsed: mem.swapUsed,
    load: os.loadavg().map(n => Number(n.toFixed(2))),
    ip: primaryIp(),
    node: process.version,
    isRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
    admin: !!ctx.admin,
    adminWrite: !!ctx.adminWrite,
    readonly: !!ctx.readonly,
    version: VERSION,
  });
}

function writeSse(res, event, data) {
  try {
    res.write(event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : `data: ${JSON.stringify(data)}\n\n`);
  } catch { /* client vanished */ }
}

function handleMetricsStream(ctx) {
  const { res } = ctx;
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return ctx.fail('Too many metric subscribers', 503);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  // Bootstrap: replay the current ring so a fresh chart renders immediately.
  writeSse(res, 'history', { ring: metrics.getRing() });

  sseClients.add(res);
  res.on('close', () => { sseClients.delete(res); });
}

// Fan-out: one tick → every subscriber.
metrics.onTick(s => {
  for (const res of sseClients) {
    if (res.writableEnded) { sseClients.delete(res); continue; }
    if (res.write(`data: ${JSON.stringify(s)}\n\n`) === false) { /* backpressure: drop this frame */ }
  }
});

/** Downsample rows to at most `maxPoints` bucket averages. Pure-ish; tested via query. */
function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const bucket = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += bucket) {
    const slice = rows.slice(i, i + bucket);
    const sum = { cpu: 0, mem_used: 0, net_rx: 0, net_tx: 0, disk_read: 0, disk_write: 0 };
    for (const r of slice) {
      sum.cpu += r.cpu || 0;
      sum.mem_used += r.mem_used || 0;
      sum.net_rx += r.net_rx || 0;
      sum.net_tx += r.net_tx || 0;
      sum.disk_read += r.disk_read || 0;
      sum.disk_write += r.disk_write || 0;
    }
    const n = slice.length;
    out.push({
      ts: slice[0].ts,
      cpu: sum.cpu / n,
      mem_used: Math.round(sum.mem_used / n),
      mem_total: slice[0].mem_total,
      net_rx: sum.net_rx, net_tx: sum.net_tx,
      disk_read: sum.disk_read, disk_write: sum.disk_write,
      load1: slice[0].load1,
    });
  }
  return out;
}

const RANGE_SECONDS = { '5m': 300, '30m': 1800, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };

function handleMetricsHistory(ctx) {
  const { params, ok, fail } = ctx;
  if (!isOpen()) return fail('history store is not open', 503);
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  let to = parseInt(params.to, 10) || nowSec;
  let from;
  if (params.from) from = parseInt(params.from, 10);
  else {
    const range = RANGE_SECONDS[params.range] || RANGE_SECONDS['1h'];
    from = to - range;
  }
  if (!(from < to)) return fail('invalid range', 400);
  try {
    const rows = db.prepare(
      'SELECT ts, cpu, mem_used, mem_total, net_rx, net_tx, disk_read, disk_write, load1 ' +
      'FROM metrics_min WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'
    ).all(from, to);
    ok({ from, to, step: 60, points: downsample(rows, HISTORY_MAX_POINTS) });
  } catch (e) { fail(e.message); }
}

function dbSizeBytes() {
  const db = getDb();
  if (!db) return 0;
  try {
    const pageCount = db.prepare('PRAGMA page_count').get();
    const pageSize = db.prepare('PRAGMA page_size').get();
    const c = pageCount && (pageCount.page_count ?? Object.values(pageCount)[0]);
    const s = pageSize && (pageSize.page_size ?? Object.values(pageSize)[0]);
    return (c || 0) * (s || 0);
  } catch { return 0; }
}

function handleHealth(ctx) {
  const mem = process.memoryUsage();
  ctx.ok({
    uptime: Math.round(process.uptime()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    eventLoopDelay: loopDelayMs(),
    metricsRunning: metrics.isRunning(),
    sseClients: sseClients.size,
    dbOpen: isOpen(),
    dbSize: dbSizeBytes(),
    version: VERSION,
    pid: process.pid,
  });
}

function handleAudit(ctx) {
  const { params, ok, fail } = ctx;
  if (!isOpen()) return fail('audit store is not open', 503);
  try {
    ok(audit.query({ limit: params.limit, offset: params.offset, action: params.action }));
  } catch (e) { fail(e.message); }
}

// --- TOTP enrollment -------------------------------------------------------

function readJsonBody(req, cb, max = 4096) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

function setMeta(key, value) {
  const db = getDb();
  if (!db) return;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function getMeta(key) {
  const db = getDb();
  if (!db) return null;
  try { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
  catch { return null; }
}
function delMeta(key) {
  const db = getDb();
  if (!db) return;
  try { db.prepare('DELETE FROM meta WHERE key = ?').run(key); } catch {}
}

/** Load a previously-enrolled TOTP secret (called at startup). */
function loadTotp() {
  const s = getMeta('totp_secret');
  if (s) auth.setTotpSecret(s);
}

function handleTotpStatus(ctx) {
  ctx.ok({ enabled: auth.totpEnabled(), pending: !!getMeta('totp_pending') });
}

function totpPayload(secret) {
  // Label so several machines are distinguishable in the authenticator app:
  //   edlics_<hostname>_<first 4 of the key>
  const host = String(os.hostname() || 'host').replace(/[^A-Za-z0-9_.-]/g, '_');
  const label = `edlics_${host}_${secret.slice(0, 4)}`;
  return { secret, url: totp.otpauthUrl(secret, null, 'edlics', { label }), pending: true };
}

function handleTotpEnroll(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Enabling 2FA requires --admin-write', 403);
  if (auth.totpEnabled()) return fail('TOTP is already enabled', 409);
  // Idempotent: reuse the existing pending secret so it stays the same across
  // dialog opens and process restarts. Only /regenerate mints a new one.
  let secret = getMeta('totp_pending');
  if (!secret) {
    secret = totp.generateSecret();
    setMeta('totp_pending', secret);
    audit.log('totp.enroll-pending', { ip: ctx.clientIp || (req.socket && req.socket.remoteAddress) || 'unknown', ua: req.headers['user-agent'] || '', result: 'ok' });
  }
  ok(totpPayload(secret));
}

/** Explicitly mint a fresh pending secret (user-triggered). */
function handleTotpRegenerate(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Requires --admin-write', 403);
  if (auth.totpEnabled()) return fail('Disable 2FA first', 409);
  const secret = totp.generateSecret();
  setMeta('totp_pending', secret);
  audit.log('totp.regenerate', { ip: ctx.clientIp || (req.socket && req.socket.remoteAddress) || 'unknown', ua: req.headers['user-agent'] || '', result: 'ok' });
  ok(totpPayload(secret));
}

function handleTotpConfirm(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Enabling 2FA requires --admin-write', 403);
  const pending = getMeta('totp_pending');
  if (!pending) return fail('No pending 2FA enrollment', 400);
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    // 400 (not 401) on a bad code — 401 would be read by the client as an
    // expired session and pop the login gate.
    if (!totp.verify(pending, data.code || '')) return fail('Invalid code — check the authenticator and try again', 400);
    setMeta('totp_secret', pending);
    delMeta('totp_pending');
    auth.setTotpSecret(pending);
    audit.log('totp.enable', { ip: ctx.clientIp || (req.socket && req.socket.remoteAddress) || 'unknown', ua: req.headers['user-agent'] || '', result: 'ok' });
    ok({ enabled: true });
  });
}

/** Side-effect-free code check (pending secret first, else active) for live
 *  validation in the UI. Always 200 with { valid }. */
function handleTotpVerify(ctx) {
  const { req, ok, fail } = ctx;
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const secret = getMeta('totp_pending') || getMeta('totp_secret') || '';
    ok({ valid: !!secret && totp.verify(secret, String(data.code || '')) });
  });
}

function handleTotpCancel(ctx) {
  const { ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Requires --admin-write', 403);
  delMeta('totp_pending');
  ok({ ok: true });
}

function handleTotpDisable(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Disabling 2FA requires --admin-write', 403);
  return readJsonBody(req, data => {
    if (!data) return fail('Invalid JSON', 400);
    const active = getMeta('totp_secret') || '';
    if (!totp.verify(active, data.code || '')) return fail('Invalid code', 400);
    // Keep the key (as pending) so re-enabling reuses the same one; the user
    // can mint a fresh key with the refresh button if they want.
    if (active) setMeta('totp_pending', active);
    delMeta('totp_secret');
    auth.setTotpSecret(null);
    audit.log('totp.disable', { ip: req.socket.remoteAddress || 'unknown', ua: req.headers['user-agent'] || '', result: 'ok' });
    ok({ ok: true });
  });
}

// --- lifecycle: persistence + retention ------------------------------------

function persistMinute(row) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO metrics_min
        (ts, cpu, mem_used, mem_total, swap_used, swap_total, load1, load5, load15,
         uptime, net_rx, net_tx, disk_read, disk_write, samples)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.ts, row.cpu, row.mem_used, row.mem_total, row.swap_used, row.swap_total,
      row.load1, row.load5, row.load15, row.uptime, row.net_rx, row.net_tx,
      row.disk_read, row.disk_write, row.samples);
  } catch { /* keep sampling even if a write fails */ }
}

function sweep() {
  const db = getDb();
  if (db) {
    try {
      db.prepare('DELETE FROM metrics_min WHERE ts < ?')
        .run(Math.floor(Date.now() / 1000) - retentionDays * 86400);
    } catch {}
  }
  audit.prune(90);
}

let retentionDays = DEFAULT_RETENTION_DAYS;

/**
 * Start sampling + persistence + retention. Call once at startup (--admin).
 * @param {{retentionDays?:number, intervalMs?:number}} [opts]
 */
function init(opts = {}) {
  retentionDays = opts.retentionDays || DEFAULT_RETENTION_DAYS;
  metrics.start({ intervalMs: opts.intervalMs, onMinute: persistMinute });
  retentionTimer = setInterval(sweep, 3600 * 1000);
  retentionTimer.unref?.();
  keepAliveTimer = setInterval(() => {
    for (const res of sseClients) { try { res.write(': ping\n\n'); } catch {} }
  }, 25000);
  keepAliveTimer.unref?.();
}

/** Stop sampling and detach every SSE client (graceful shutdown). */
function shutdown() {
  metrics.flush();
  metrics.stop();
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  for (const res of sseClients) { try { res.end(); } catch {} }
  sseClients.clear();
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/info',           match: p => p[1] === 'sys' && p[2] === 'info',                                 handle: handleInfo },
  { name: 'api/sys/metrics/stream', match: p => p[1] === 'sys' && p[2] === 'metrics' && p[3] === 'stream',         handle: handleMetricsStream },
  { name: 'api/sys/metrics',        match: p => p[1] === 'sys' && p[2] === 'metrics' && !p[3],                     handle: handleMetricsHistory },
  { name: 'api/sys/health',         match: p => p[1] === 'sys' && p[2] === 'health',                               handle: handleHealth },
  { name: 'api/sys/audit',          match: p => p[1] === 'sys' && p[2] === 'audit',                                handle: handleAudit },
  { name: 'api/sys/totp',           match: p => p[1] === 'sys' && p[2] === 'totp' && !p[3],                        handle: handleTotpStatus },
  { name: 'api/sys/totp/enroll',    match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'enroll',            handle: handleTotpEnroll },
  { name: 'api/sys/totp/regenerate', match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'regenerate',        handle: handleTotpRegenerate },
  { name: 'api/sys/totp/confirm',   match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'confirm',           handle: handleTotpConfirm },
  { name: 'api/sys/totp/verify',    match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'verify',            handle: handleTotpVerify },
  { name: 'api/sys/totp/cancel',    match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'cancel',            handle: handleTotpCancel },
  { name: 'api/sys/totp/disable',   match: p => p[1] === 'sys' && p[2] === 'totp' && p[3] === 'disable',           handle: handleTotpDisable },
];

module.exports = {
  routes, init, shutdown, persistMinute, sweep, downsample, parseOsRelease, loadTotp,
  MAX_SSE_CLIENTS, DEFAULT_RETENTION_DAYS, RANGE_SECONDS,
};

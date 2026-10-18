// metrics.js — Linux /proc sampler (CPU, memory, load, network, disk).
//
// Design (see docs/ADMIN-PANEL-PLAN.md, Phase 2):
//   * ONE global sampler at 1s — never per-client.
//   * A fixed-size ring buffer feeds live charts; a minute accumulator is
//     flushed to SQLite via the onMinute callback (dependency-inverted: this
//     module never touches the DB itself).
//   * Parsers are pure and exported for unit tests.
//
// /proc is a kernel pseudo-filesystem (no disk IO), so the tiny synchronous
// reads here do not block the event loop the way sync reads on real files do.
const fs = require('fs');

const RING_SIZE = 180;          // ~3 minutes of raw 1s samples
const MINUTE_MS = 60 * 1000;

let ring = [];
let prev = null;                // previous counters, for rate/delta math
const listeners = new Set();
let timer = null;
let running = false;
let acc = null;                 // current minute accumulator
let onMinuteCb = null;

// --- pure parsers (exported for tests) -------------------------------------

/**
 * First "cpu" line of /proc/stat.
 * @param {string} text
 * @returns {{user:number,nice:number,system:number,idle:number,iowait:number,
 *   irq:number,softirq:number,steal:number,idleAll:number,total:number}|null}
 */
function parseCpuLine(text) {
  const first = String(text || '').split('\n')[0].trim();
  if (!first.startsWith('cpu')) return null;
  const f = first.split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = f;
  const idleAll = (idle || 0) + (iowait || 0);
  const total = (user || 0) + (nice || 0) + (system || 0) + (idle || 0) +
    (iowait || 0) + (irq || 0) + (softirq || 0) + (steal || 0);
  return { user: user || 0, nice: nice || 0, system: system || 0, idle: idle || 0,
    iowait: iowait || 0, irq: irq || 0, softirq: softirq || 0, steal: steal || 0,
    idleAll, total };
}

/**
 * /proc/meminfo → bytes. Keeps every key it finds (kB multiplied by 1024).
 * @param {string} text
 * @returns {Record<string, number>}
 */
function parseMeminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)/.exec(line);
    if (m) out[m[1]] = parseInt(m[2], 10) * 1024; // kB → bytes
  }
  return out;
}

/** /proc/loadavg → {load1,load5,load15}. */
function parseLoadavg(text) {
  const f = String(text || '').trim().split(/\s+/).map(Number);
  return { load1: f[0] || 0, load5: f[1] || 0, load15: f[2] || 0 };
}

/** /proc/uptime → seconds (float). */
function parseUptime(text) {
  return parseFloat(String(text || '').trim().split(/\s+/)[0]) || 0;
}

/**
 * /proc/net/dev → summed rx/tx bytes across real interfaces (lo excluded).
 * @returns {{rx:number,tx:number,ifaces:string[]}}
 */
function parseNetDev(text) {
  let rx = 0, tx = 0;
  const ifaces = [];
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || name === 'lo') continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 16) continue;
    rx += f[0] || 0;
    tx += f[8] || 0;
    ifaces.push(name);
  }
  return { rx, tx, ifaces };
}

/**
 * /proc/diskstats → summed read/write bytes (sectors × 512).
 * @param {string} text
 * @param {Set<string>|null} [wholeSet] whole-disk names from /sys/block; when
 *   given, only those are summed (avoids counting partitions twice).
 */
function parseDiskstats(text, wholeSet) {
  let readBytes = 0, writeBytes = 0;
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (wholeSet && wholeSet.size) {
      if (!wholeSet.has(name)) continue;
    } else if (/^(loop|ram|sr|fd)/.test(name)) {
      continue; // no physical disk enumeration available → best-effort filter
    }
    readBytes += (Number(f[5]) || 0) * 512;  // sectors read
    writeBytes += (Number(f[9]) || 0) * 512; // sectors written
  }
  return { readBytes, writeBytes };
}

/** CPU utilisation % between two parseCpuLine() snapshots. */
function computeCpuPct(prevCpu, curCpu) {
  if (!prevCpu || !curCpu) return 0;
  const dTotal = curCpu.total - prevCpu.total;
  const dIdle = curCpu.idleAll - prevCpu.idleAll;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
}

// --- /sys/block whole-disk enumeration -------------------------------------

let wholeDisks = null;
function getWholeDisks() {
  if (wholeDisks) return wholeDisks;
  try { wholeDisks = new Set(fs.readdirSync('/sys/block')); } catch { wholeDisks = new Set(); }
  return wholeDisks;
}

function readProc(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }

/**
 * Read /proc once and return a normalised sample. Exported for tests.
 * @param {number} [now] epoch ms
 */
function sampleOnce(now = Date.now()) {
  const mem = parseMeminfo(readProc('/proc/meminfo'));
  const load = parseLoadavg(readProc('/proc/loadavg'));
  const net = parseNetDev(readProc('/proc/net/dev'));
  const disk = parseDiskstats(readProc('/proc/diskstats'), getWholeDisks());
  const cpu = parseCpuLine(readProc('/proc/stat'));

  const cpuPct = (prev && cpu)
    ? computeCpuPct({ total: prev.cpuTotal, idleAll: prev.cpuIdle }, cpu)
    : 0;
  const dt = prev ? Math.max(0.001, (now - prev.ts) / 1000) : 0;

  const dNetRx = prev ? Math.max(0, net.rx - prev.netRx) : 0;
  const dNetTx = prev ? Math.max(0, net.tx - prev.netTx) : 0;
  const dDiskR = prev ? Math.max(0, disk.readBytes - prev.diskRead) : 0;
  const dDiskW = prev ? Math.max(0, disk.writeBytes - prev.diskWrite) : 0;

  const memTotal = mem.MemTotal || 0;
  const memAvail = mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0);

  const s = {
    t: now,
    cpu: cpuPct,
    memUsed: Math.max(0, memTotal - memAvail),
    memTotal,
    memFree: mem.MemFree || 0,
    swapUsed: Math.max(0, (mem.SwapTotal || 0) - (mem.SwapFree || 0)),
    swapTotal: mem.SwapTotal || 0,
    load1: load.load1, load5: load.load5, load15: load.load15,
    uptime: parseUptime(readProc('/proc/uptime')),
    netRx: dNetRx, netTx: dNetTx,
    netRxRate: dt ? dNetRx / dt : 0, netTxRate: dt ? dNetTx / dt : 0,
    diskRead: dDiskR, diskWrite: dDiskW,
    diskReadRate: dt ? dDiskR / dt : 0, diskWriteRate: dt ? dDiskW / dt : 0,
  };

  prev = {
    ts: now,
    cpuTotal: cpu ? cpu.total : 0,
    cpuIdle: cpu ? cpu.idleAll : 0,
    netRx: net.rx, netTx: net.tx,
    diskRead: disk.readBytes, diskWrite: disk.writeBytes,
  };
  return s;
}

// --- minute aggregation ----------------------------------------------------

function accumulate(s) {
  const minute = Math.floor(s.t / MINUTE_MS);
  if (!acc || acc.minute !== minute) {
    if (acc && acc.n) flushMinute(acc);
    acc = { minute, n: 0, cpu: 0, memUsed: 0, memTotal: 0, swapUsed: 0, swapTotal: 0,
      load1: 0, load5: 0, load15: 0, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0, uptime: 0 };
  }
  acc.n++;
  acc.cpu += s.cpu;
  acc.memUsed += s.memUsed; acc.memTotal += s.memTotal;
  acc.swapUsed += s.swapUsed; acc.swapTotal += s.swapTotal;
  acc.load1 += s.load1; acc.load5 += s.load5; acc.load15 += s.load15;
  acc.netRx += s.netRx; acc.netTx += s.netTx;
  acc.diskRead += s.diskRead; acc.diskWrite += s.diskWrite;
  acc.uptime = s.uptime;
}

function flushMinute(a) {
  if (!onMinuteCb || !a || !a.n) return;
  onMinuteCb({
    ts: a.minute * 60, // epoch seconds at the minute boundary
    cpu: a.cpu / a.n,
    mem_used: Math.round(a.memUsed / a.n),
    mem_total: Math.round(a.memTotal / a.n),
    swap_used: Math.round(a.swapUsed / a.n),
    swap_total: Math.round(a.swapTotal / a.n),
    load1: a.load1 / a.n, load5: a.load5 / a.n, load15: a.load15 / a.n,
    uptime: Math.round(a.uptime),
    net_rx: a.netRx, net_tx: a.netTx,
    disk_read: a.diskRead, disk_write: a.diskWrite,
    samples: a.n,
  });
}

// --- lifecycle -------------------------------------------------------------

/**
 * @param {{intervalMs?:number, onMinute?:(row:object)=>void}} [opts]
 */
function start(opts = {}) {
  if (running) return;
  onMinuteCb = opts.onMinute || null;
  const intervalMs = Math.max(250, opts.intervalMs || 1000);
  const tick = () => {
    const s = sampleOnce();
    ring.push(s);
    if (ring.length > RING_SIZE) ring.shift();
    accumulate(s);
    for (const fn of listeners) { try { fn(s); } catch { /* one bad client */ } }
  };
  tick();                     // seed `prev` immediately so the next tick has a delta
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  running = true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
}

/** Force-flush the in-progress minute (called on shutdown). */
function flush() { if (acc && acc.n) { flushMinute(acc); acc = null; } }

function onTick(fn) { listeners.add(fn); }
function offTick(fn) { listeners.delete(fn); }

function getLatest() { return ring.length ? ring[ring.length - 1] : null; }
function getRing() { return ring; }
function isRunning() { return running; }

/** Test hook: clear all module state. */
function _reset() {
  stop();
  ring = []; prev = null; acc = null; onMinuteCb = null; wholeDisks = null;
  listeners.clear();
}

/** Test hook: inject the minute flush callback without starting the timer. */
function _setOnMinute(fn) { onMinuteCb = fn; }

module.exports = {
  start, stop, flush, onTick, offTick, getLatest, getRing, isRunning,
  sampleOnce, accumulate, flushMinute, computeCpuPct,
  parseCpuLine, parseMeminfo, parseLoadavg, parseUptime, parseNetDev, parseDiskstats,
  RING_SIZE, MINUTE_MS, _reset, _setOnMinute,
};

// Unit tests: /proc parsers and the minute aggregator (pure, no timers).
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../bin/lib/metrics');

test('parseCpuLine: sums fields, idleAll includes iowait', () => {
  const c = m.parseCpuLine('cpu  100 20 30 800 50 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0');
  assert.strictEqual(c.user, 100);
  assert.strictEqual(c.idle, 800);
  assert.strictEqual(c.iowait, 50);
  assert.strictEqual(c.idleAll, 850);
  assert.strictEqual(c.total, 100 + 20 + 30 + 800 + 50);
  assert.strictEqual(m.parseCpuLine('not cpu'), null);
});

test('computeCpuPct: delta-based, clamped, safe on zero delta', () => {
  assert.ok(Math.abs(m.computeCpuPct({ total: 1000, idleAll: 800 }, { total: 2000, idleAll: 1500 }) - 30) < 1e-9);
  assert.strictEqual(m.computeCpuPct({ total: 1000, idleAll: 800 }, { total: 1000, idleAll: 800 }), 0);
  assert.strictEqual(m.computeCpuPct(null, { total: 10, idleAll: 1 }), 0);
  assert.strictEqual(m.computeCpuPct({ total: 5, idleAll: 0 }, { total: 4, idleAll: 0 }), 0); // counter reset
});

test('parseMeminfo: kB → bytes', () => {
  const mem = m.parseMeminfo('MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\nHugePages_Total:       0\n');
  assert.strictEqual(mem.MemTotal, 16384000 * 1024);
  assert.strictEqual(mem.MemAvailable, 8000000 * 1024);
});

test('parseNetDev: sums real interfaces, skips loopback and headers', () => {
  const text = 'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
    '    lo: 999 9 0 0 0 0 0 0 999 9 0 0 0 0 0 0\n' +
    '  eth0: 5000 3 0 0 0 0 0 0 7000 4 0 0 0 0 0 0\n' +
    '  eth1: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n';
  const n = m.parseNetDev(text);
  assert.strictEqual(n.rx, 6000);
  assert.strictEqual(n.tx, 9000);
  assert.deepStrictEqual(n.ifaces, ['eth0', 'eth1']);
});

test('parseDiskstats: sectors × 512, filters loop/ram by default', () => {
  const line = (name, sr, sw) => `8 0 ${name} 10 5 ${sr} 20 30 7 ${sw} 40 0 0 0 0 0`;
  const text = line('sda', 100, 200) + '\n' + line('loop0', 999, 999) + '\n' + line('ram0', 999, 999) + '\n';
  const d = m.parseDiskstats(text);
  assert.strictEqual(d.readBytes, 100 * 512);
  assert.strictEqual(d.writeBytes, 200 * 512);
  // whole-disk allowlist wins when provided (partitions excluded)
  const only = m.parseDiskstats(line('sda', 100, 200) + '\n' + line('sda1', 50, 50) + '\n', new Set(['sda']));
  assert.strictEqual(only.readBytes, 100 * 512);
});

test('parseLoadavg / parseUptime', () => {
  assert.deepStrictEqual(m.parseLoadavg('0.52 0.58 0.59 2/345 12345'), { load1: 0.52, load5: 0.58, load15: 0.59 });
  assert.strictEqual(m.parseUptime('12345.67 98765.43'), 12345.67);
});

test('accumulate + flushMinute: buckets average, sums deltas', () => {
  m._reset();
  const rows = [];
  m._setOnMinute(r => rows.push(r));
  const base = 60 * 1000 * 3; // minute 3
  const mk = (dt, cpu) => ({
    t: base + dt, cpu, memUsed: 100, memTotal: 200, swapUsed: 0, swapTotal: 0,
    load1: 1, load5: 1, load15: 1, uptime: 10, netRx: 500, netTx: 700, diskRead: 10, diskWrite: 20,
  });
  m.accumulate(mk(0, 10));
  m.accumulate(mk(1000, 30));
  m.flush();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].cpu, 20);          // (10+30)/2
  assert.strictEqual(rows[0].net_rx, 1000);     // summed
  assert.strictEqual(rows[0].samples, 2);
  m._reset();
});

test('accumulate: minute rollover flushes the previous bucket', () => {
  m._reset();
  const rows = [];
  m._setOnMinute(r => rows.push(r));
  const s = (t) => ({
    t, cpu: 5, memUsed: 1, memTotal: 2, swapUsed: 0, swapTotal: 0,
    load1: 0, load5: 0, load15: 0, uptime: 1, netRx: 1, netTx: 1, diskRead: 0, diskWrite: 0,
  });
  m.accumulate(s(60 * 1000 * 10 + 100)); // minute 10
  m.accumulate(s(60 * 1000 * 11 + 100)); // minute 11 → flush minute 10
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ts, 60 * 10);
  m._reset();
});

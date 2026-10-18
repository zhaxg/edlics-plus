// Unit tests: /proc/<pid>/stat parsing, CPU delta math, passwd map, live sample.
const { test } = require('node:test');
const assert = require('node:assert');
const p = require('../bin/lib/processes-api');

test('parseProcStat: comm with spaces/parens, field offsets', () => {
  // state (S) then ppid, ..., utime=15 stime=25 threads=3 starttime=9999
  const line = '1234 (my worker (v2)) S 1000 1234 1234 0 -1 4194560 123 0 0 0 ' +
    '15 25 0 0 20 0 3 0 9999 123456789 456 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
  const s = p.parseProcStat(line);
  assert.strictEqual(s.pid, 1234);
  assert.strictEqual(s.comm, 'my worker (v2)');
  assert.strictEqual(s.state, 'S');
  assert.strictEqual(s.ppid, 1000);
  assert.strictEqual(s.utime, 15);
  assert.strictEqual(s.stime, 25);
  assert.strictEqual(s.threads, 3);
  assert.strictEqual(s.starttime, 9999);
  assert.strictEqual(s.vsize, 123456789);
  assert.strictEqual(s.rss, 456);
  assert.strictEqual(p.parseProcStat('garbage'), null);
});

test('parseCpuTotal: sums the cpu line fields', () => {
  assert.strictEqual(p.parseCpuTotal('cpu  1 2 3 4 5 6 7 8 9 10\ncpu0 1 1 1'), 55);
  assert.strictEqual(p.parseCpuTotal('nope'), 0);
});

test('computeProcCpu: delta over machine jiffies, clamped, safe', () => {
  assert.strictEqual(p.computeProcCpu(100, 150, 1000), 5);
  assert.strictEqual(p.computeProcCpu(null, 150, 1000), 0);
  assert.strictEqual(p.computeProcCpu(100, 150, 0), 0);
  assert.strictEqual(p.computeProcCpu(150, 100, 1000), 0); // counter reset
});

test('parsePasswdMap: uid → name', () => {
  const m = p.parsePasswdMap('root:x:0:0::/root:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/sh\n');
  assert.strictEqual(m.get(0), 'root');
  assert.strictEqual(m.get(1001), 'alice');
});

test('sampleProcesses: finds our own pid in the live list', () => {
  const snap = p.sampleProcesses();
  assert.ok(snap.total > 0);
  assert.strictEqual(typeof snap.memTotal, 'number');
  const self = snap.processes.find(x => x.pid === process.pid);
  assert.ok(self, 'own process present');
  assert.ok(self.cmd.includes('node') || self.name.includes('node'), 'own cmd/name');
});

test('SIGNALS allowlist is closed', () => {
  assert.ok(p.SIGNALS.has('TERM'));
  assert.ok(p.SIGNALS.has('KILL'));
  assert.ok(!p.SIGNALS.has('SIGSEGV'));
  assert.ok(!p.SIGNALS.has('9'));
});

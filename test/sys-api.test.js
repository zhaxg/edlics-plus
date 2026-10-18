// Unit tests: sys-api pure helpers (os-release parsing, downsampling, ranges).
const { test } = require('node:test');
const assert = require('node:assert');
const sys = require('../bin/lib/sys-api');

test('parseOsRelease: key=value with quoted values', () => {
  const rel = sys.parseOsRelease('NAME="Ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nID=ubuntu\n');
  assert.strictEqual(rel.NAME, 'Ubuntu');
  assert.strictEqual(rel.PRETTY_NAME, 'Ubuntu 22.04.3 LTS');
  assert.strictEqual(rel.ID, 'ubuntu');
});

test('downsample: identity below cap, bucketed averages above', () => {
  const mk = i => ({ ts: i, cpu: i, mem_used: 100, mem_total: 1000, net_rx: 60, net_tx: 30, disk_read: 0, disk_write: 0, load1: 1 });
  const small = Array.from({ length: 10 }, (_, i) => mk(i));
  assert.strictEqual(sys.downsample(small, 100).length, 10);

  const big = Array.from({ length: 1000 }, (_, i) => mk(i));
  const out = sys.downsample(big, 100);
  assert.ok(out.length <= 100, 'bounded to maxPoints');
  assert.strictEqual(out[0].ts, 0);
  // first bucket averages cpu 0..9 → 4.5
  assert.strictEqual(Math.round(out[0].cpu * 10) / 10, 4.5);
  // per-bucket deltas are summed (60/30 × bucket size)
  assert.strictEqual(out[0].net_rx, 60 * Math.ceil(1000 / 100));
});

test('RANGE_SECONDS covers the UI options', () => {
  for (const k of ['5m', '30m', '1h', '6h', '24h', '7d', '30d']) {
    assert.ok(sys.RANGE_SECONDS[k] > 0, k + ' defined');
  }
});

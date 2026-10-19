// Unit tests: disk output parsers (df / lsblk -J / findmnt -J).
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../bin/lib/disk-api');

test('parseDf: skips header, handles wrapped mount names', () => {
  const text =
    'Filesystem      Size  Used Avail Use% Mounted on\n' +
    '/dev/sda1       116G   32G   80G  29% /\n' +
    'tmpfs           795M  1.0M  794M   1% /run\n' +
    'tmpfs           795M  1.0M  794M   1% /run/credentials/x.service\n';
  const rows = d.parseDf(text);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { fs: '/dev/sda1', size: '116G', used: '32G', avail: '80G', pct: '29%', mount: '/' });
  assert.strictEqual(rows[2].mount, '/run/credentials/x.service');
  assert.deepStrictEqual(d.parseDf('garbage'), []);
});

test('parseLsblk: flattens children with depth', () => {
  const json = JSON.stringify({ blockdevices: [
    { name: 'sda', type: 'disk', size: '120G', fstype: null, mountpoint: null, ro: false, tran: null, model: 'Virtual disk',
      children: [ { name: 'sda1', type: 'part', size: '119G', fstype: 'ext4', mountpoint: '/', ro: false, tran: null, model: null } ] },
  ] });
  const out = d.parseLsblk(json);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'sda');
  assert.strictEqual(out[0].depth, 0);
  assert.strictEqual(out[1].name, 'sda1');
  assert.strictEqual(out[1].depth, 1);
  assert.strictEqual(out[1].mountpoint, '/');
  assert.deepStrictEqual(d.parseLsblk('nope'), []);
});

test('parseFindmnt: flattens the mount tree', () => {
  const json = JSON.stringify({ filesystems: [
    { target: '/', source: '/dev/sda1', fstype: 'ext4', size: '116G', used: '31G', avail: '80G', 'use%': '27%',
      children: [ { target: '/sys', source: 'sysfs', fstype: 'sysfs' } ] },
  ] });
  const out = d.parseFindmnt(json);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].target, '/');
  assert.strictEqual(out[0].usePct, '27%');
  assert.strictEqual(out[1].depth, 1);
  assert.strictEqual(out[1].fstype, 'sysfs');
  assert.deepStrictEqual(d.parseFindmnt('nope'), []);
});

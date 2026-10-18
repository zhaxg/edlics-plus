// Unit tests: systemd unit-name validation and output parsers (pure).
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../bin/lib/services-api');

test('isValidUnitName: shape check blocks traversal and odd input', () => {
  assert.ok(s.isValidUnitName('nginx.service'));
  assert.ok(s.isValidUnitName('getty@tty1.service'));
  assert.ok(s.isValidUnitName('systemd-networkd-wait-online.service'));
  assert.ok(!s.isValidUnitName('../../etc/passwd'));
  assert.ok(!s.isValidUnitName('nginx'));
  assert.ok(!s.isValidUnitName('foo.mount'));
  assert.ok(!s.isValidUnitName('a b.service'));
  assert.ok(!s.isValidUnitName('--now.service'));
  assert.ok(!s.isValidUnitName(''));
  assert.ok(!s.isValidUnitName('x'.repeat(200) + '.service'));
  assert.ok(!s.isValidUnitName(null));
});

test('parseUnitList: keeps services, maps fields, tolerates bad JSON', () => {
  const json = JSON.stringify([
    { unit: 'a.service', load: 'loaded', active: 'active', sub: 'running', description: 'A svc' },
    { unit: 'b.mount', load: 'loaded', active: 'active', sub: 'mounted', description: 'B' },
  ]);
  const units = s.parseUnitList(json);
  assert.strictEqual(units.length, 1);
  assert.deepStrictEqual(units[0], { name: 'a.service', load: 'loaded', active: 'active', sub: 'running', description: 'A svc' });
  assert.deepStrictEqual(s.parseUnitList('not json'), []);
  assert.deepStrictEqual(s.parseUnitList('{}'), []);
});

test('parseUnitFiles: returns a set of .service names', () => {
  const json = JSON.stringify([
    { unit_file: 'a.service', state: 'enabled' },
    { unit_file: 'b.socket', state: 'disabled' },
  ]);
  const set = s.parseUnitFiles(json);
  assert.ok(set.has('a.service'));
  assert.ok(!set.has('b.socket'));
});

test('parseJournal: JSON-lines, binary MESSAGE decoded, bad lines skipped', () => {
  const line = o => JSON.stringify(o);
  const text = [
    line({ __REALTIME_TIMESTAMP: '1700000000000000', MESSAGE: 'hello', PRIORITY: '6', _COMM: 'nginx', _PID: '10' }),
    line({ __REALTIME_TIMESTAMP: '1700000001000000', MESSAGE: [104, 105], PRIORITY: '3' }), // "hi"
    'garbage not json',
    '',
  ].join('\n');
  const rows = s.parseJournal(text);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].message, 'hello');
  assert.strictEqual(rows[0].ts, 1700000000000);
  assert.strictEqual(rows[0].priority, 6);
  assert.strictEqual(rows[1].message, 'hi');
  assert.strictEqual(rows[1].priority, 3);
});

test('ACTIONS allowlist is closed', () => {
  for (const a of ['start', 'stop', 'restart', 'reload', 'enable', 'disable']) assert.ok(s.ACTIONS.has(a));
  assert.ok(!s.ACTIONS.has('mask'));
  assert.ok(!s.ACTIONS.has('kill'));
});

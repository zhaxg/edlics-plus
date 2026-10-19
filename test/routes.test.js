// Unit tests: /proc/net/route parsing (IPv4 route table, route -n columns).
const { test } = require('node:test');
const assert = require('node:assert');
const n = require('../bin/lib/network-api');

test('hexToIp: little-endian dotted quad', () => {
  assert.strictEqual(n.hexToIp('00000000'), '0.0.0.0');
  assert.strictEqual(n.hexToIp('0102A8C0'), '192.168.2.1');   // C0.A8.02.01 reversed
  assert.strictEqual(n.hexToIp('00FFFFFF'), '255.255.255.0');
  assert.strictEqual(n.hexToIp('0184A8C0'), '192.168.132.1');
});

test('routeFlags: real RTF bits (U/G/H/!/D/M)', () => {
  assert.strictEqual(n.routeFlags('0001'), 'U');
  assert.strictEqual(n.routeFlags('0003'), 'UG');      // default route
  assert.strictEqual(n.routeFlags('0007'), 'UGH');     // host route via gateway
  assert.strictEqual(n.routeFlags('0201'), 'U!');      // reject
  assert.strictEqual(n.routeFlags('0000'), '0');
});

test('parseProcNetRoute: full table from raw /proc/net/route', () => {
  const raw =
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'ens192\t00000000\t0184A8C0\t0003\t0\t0\t1002\t00000000\t0\t0\t0\n' +
    'ens192\tC669A868\t0184A8C0\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0\n' +
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  const rows = n.parseProcNetRoute(raw);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { iface: 'ens192', destination: '0.0.0.0', gateway: '192.168.132.1', flags: 'UG', metric: 1002, genmask: '0.0.0.0' });
  assert.strictEqual(rows[1].flags, 'UGH');
  assert.strictEqual(rows[1].genmask, '255.255.255.255');
  assert.deepStrictEqual(rows[2], { iface: 'docker0', destination: '172.17.0.0', gateway: '0.0.0.0', flags: 'U', metric: 0, genmask: '255.255.0.0' });
  assert.deepStrictEqual(n.parseProcNetRoute(''), []);
});

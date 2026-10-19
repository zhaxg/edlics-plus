// Unit tests: client-IP/CIDR allowlist, sliding-window limiter, TOTP (RFC 6238).
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('../bin/lib/net');
const { createLimiter } = require('../bin/lib/ratelimit');
const totp = require('../bin/lib/totp');

test('net.normalizeIp strips IPv4-mapped IPv6 prefix', () => {
  assert.strictEqual(net.normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
  assert.strictEqual(net.normalizeIp('10.0.0.1'), '10.0.0.1');
  assert.strictEqual(net.normalizeIp(undefined), '');
});

test('net.clientIp: socket by default, XFF when trustProxy>0', () => {
  const mk = (sock, xff) => ({ socket: { remoteAddress: sock }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.strictEqual(net.clientIp(mk('1.2.3.4', '9.9.9.9'), 0), '1.2.3.4');
  assert.strictEqual(net.clientIp(mk('127.0.0.1', '9.9.9.9, 8.8.8.8'), 1), '8.8.8.8');
  assert.strictEqual(net.clientIp(mk('127.0.0.1', '9.9.9.9, 8.8.8.8'), 2), '9.9.9.9');
  assert.strictEqual(net.clientIp(mk('::ffff:10.0.0.1'), 1), '10.0.0.1');
});

test('net.ipInCidr: IPv4 ranges, bare addresses, family mismatch, IPv6', () => {
  assert.ok(net.ipInCidr('10.0.0.5', '10.0.0.0/24'));
  assert.ok(!net.ipInCidr('10.0.1.5', '10.0.0.0/24'));
  assert.ok(net.ipInCidr('192.168.1.7', '192.168.1.7'));
  assert.ok(!net.ipInCidr('10.0.0.5', '::1/128'));
  assert.ok(net.ipInCidr('2001:db8::5', '2001:db8::/32'));
  assert.ok(!net.ipInCidr('2001:db9::5', '2001:db8::/32'));
  assert.ok(net.ipInCidr('1.2.3.4', '0.0.0.0/0'));
});

test('net.isAllowed: empty allowlist allows all', () => {
  assert.ok(net.isAllowed('1.2.3.4', []));
  assert.ok(net.isAllowed('1.2.3.4', null));
  const allow = net.parseAllowlist('10.0.0.0/8, 192.168.1.1, ::1');
  assert.deepStrictEqual(allow, ['10.0.0.0/8', '192.168.1.1', '::1']);
  assert.ok(net.isAllowed('10.1.2.3', allow));
  assert.ok(!net.isAllowed('11.1.2.3', allow));
});

test('ratelimit: allows up to max, then blocks with retryAfter', () => {
  const lim = createLimiter({ windowMs: 1000, max: 3 });
  assert.ok(lim.check('a').allowed);
  assert.ok(lim.check('a').allowed);
  assert.ok(lim.check('a').allowed);
  const blocked = lim.check('a');
  assert.ok(!blocked.allowed);
  assert.ok(blocked.retryAfter >= 1);
  // a different key is unaffected
  assert.ok(lim.check('b').allowed);
});

test('totp: RFC 6238 SHA-1 test vectors', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(totp.totp(secret, 59 * 1000, 8), '94287082');
  assert.strictEqual(totp.totp(secret, 1111111109 * 1000, 8), '07081804');
  assert.strictEqual(totp.totp(secret, 59 * 1000, 6), '287082');
});

test('totp: verify accepts ±1 step, rejects bad codes', () => {
  const secret = totp.generateSecret();
  const now = 1700000000000;
  const code = totp.totp(secret, now);
  assert.ok(totp.verify(secret, code, 1, now));
  assert.ok(totp.verify(secret, code, 1, now + 25 * 1000));   // next step, window 1
  assert.ok(!totp.verify(secret, code, 1, now + 5 * 60 * 1000));
  assert.ok(!totp.verify(secret, '000000', 1, now));
  assert.ok(!totp.verify(secret, 'abc', 1, now));
});

test('totp.otpauthUrl: shape', () => {
  const url = totp.otpauthUrl('ABCDEF', 'admin', 'Edlics');
  assert.match(url, /^otpauth:\/\/totp\/Edlics(:|%3A)admin\?secret=ABCDEF&issuer=Edlics/);
});

test('totp.otpauthUrl: custom label (host + key prefix)', () => {
  const url = totp.otpauthUrl('ABCDEFGH', null, 'edlics', { label: 'edlics_myhost_ABCD' });
  assert.match(url, /^otpauth:\/\/totp\/edlics_myhost_ABCD\?secret=ABCDEFGH&issuer=edlics&algorithm=SHA1&digits=6&period=30$/);
});

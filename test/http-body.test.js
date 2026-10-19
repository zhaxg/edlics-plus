// Bounded body reading + the plain-HTTP exposure warning.
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { readJsonBody, withJsonBody, DEFAULT_MAX, FILE_MAX } = require('../bin/lib/http-body');
const net = require('../bin/lib/net');

/** Build a fake IncomingMessage around a string body. */
function fakeReq(body, headers = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.headers = { 'content-length': String(Buffer.byteLength(body)), ...headers };
  req.destroyed2 = false;
  const destroy = req.destroy.bind(req);
  req.destroy = (...a) => { req.destroyed2 = true; return destroy(...a); };
  return req;
}

test('readJsonBody: parses a normal payload', async () => {
  const data = await readJsonBody(fakeReq('{"a":1,"b":"x"}'));
  assert.deepStrictEqual(data, { a: 1, b: 'x' });
});

test('readJsonBody: malformed JSON rejects with 400', async () => {
  await assert.rejects(readJsonBody(fakeReq('{nope')), err => err.status === 400);
});

test('readJsonBody: oversized Content-Length is refused up front with 413', async () => {
  const req = fakeReq('{}', { 'content-length': String(DEFAULT_MAX + 1) });
  await assert.rejects(readJsonBody(req), err => err.status === 413);
});

test('readJsonBody: a chunked body with no declared length is cut off', async () => {
  // No content-length: the byte counter is the only guard.
  const req = fakeReq('x'.repeat(2048), {});
  delete req.headers['content-length'];
  await assert.rejects(readJsonBody(req, 1024), err => err.status === 413);
  assert.ok(req.destroyed2, 'the stream must be destroyed, not buffered');
});

test('readJsonBody: multibyte payloads are measured in bytes', async () => {
  // '你' is 3 bytes; 400 of them = 1200 bytes, over a 1100-byte cap even
  // though the string is only 400 characters long.
  const body = JSON.stringify({ s: '你'.repeat(400) });
  assert.ok(Buffer.byteLength(body) > body.length, 'premise: 3 bytes per char, 1 unit per char');
  const req = fakeReq(body, {});
  delete req.headers['content-length'];
  await assert.rejects(readJsonBody(req, 1100), err => err.status === 413);
});

test('withJsonBody: routes errors through ctx.fail', async () => {
  let failed = null;
  const ctx = { req: fakeReq('{bad'), fail: (msg, code) => { failed = { msg, code }; } };
  await withJsonBody(ctx, () => assert.fail('must not run'));
  assert.strictEqual(failed.code, 400);
});

test('limits are sane: file writes may be larger than envelopes', () => {
  assert.ok(FILE_MAX > DEFAULT_MAX);
  assert.ok(DEFAULT_MAX <= 16 * 1024 * 1024);
});

// --- exposure warning ------------------------------------------------------

test('needsInsecureWarning: loopback binds are fine', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', '']) {
    assert.strictEqual(net.needsInsecureWarning({ hostname: host }), false, host);
  }
});

test('needsInsecureWarning: reachable bind without an allowlist warns', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
    assert.strictEqual(net.needsInsecureWarning({ hostname: host, allow: null }), true, host);
    assert.strictEqual(net.needsInsecureWarning({ hostname: host, allow: [] }), true, host);
    assert.strictEqual(net.needsInsecureWarning({ hostname: host, allow: '  ' }), true, host);
  }
});

test('needsInsecureWarning: an allowlist silences it', () => {
  assert.strictEqual(net.needsInsecureWarning({ hostname: '0.0.0.0', allow: '10.0.0.0/8' }), false);
  assert.strictEqual(net.needsInsecureWarning({ hostname: '0.0.0.0', allow: '10.0.0.0/8, 192.168.0.0/16' }), false);
});

test('insecureWarningLines: mentions the concrete trade-offs', () => {
  const text = net.insecureWarningLines({ hostname: '0.0.0.0', port: 8088 }).join('\n');
  assert.match(text, /0\.0\.0\.0:8088/);
  assert.match(text, /ssh -L 8088:127\.0\.0\.1:8088/);
  assert.match(text, /--cookie-secure/);
  assert.match(text, /--allow/);
});

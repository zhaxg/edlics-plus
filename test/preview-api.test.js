// Unit tests: /api/preview content typing, URL→path recovery and token auth.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  previewContentType, parsePreviewUrl, authorizePreview, mintToken, tokens,
} = require('../bin/lib/preview-api');

test('html variants render as documents even though static.js lacks .htm', () => {
  assert.strictEqual(previewContentType('/site/index.html'), 'text/html; charset=utf-8');
  assert.strictEqual(previewContentType('/site/index.HTM'), 'text/html; charset=utf-8');
});

test('renderable assets keep their real MIME', () => {
  assert.strictEqual(previewContentType('/site/style.css'), 'text/css');
  assert.strictEqual(previewContentType('/site/app.js'), 'application/javascript');
  assert.strictEqual(previewContentType('/site/pic.png'), 'image/png');
});

test('anything unknown is demoted to text/plain (never executable)', () => {
  assert.strictEqual(previewContentType('/tmp/payload.exe'), 'text/plain');
  assert.strictEqual(previewContentType('/tmp/README.md'), 'text/plain');
  assert.strictEqual(previewContentType('/tmp/no-extension'), 'application/octet-stream');
});

test('a live leading segment is the token and the rest is the absolute path', () => {
  const token = mintToken(false);
  assert.deepStrictEqual(
    parsePreviewUrl('/api/preview/' + token + '/E%3A/site/index.html', tokens),
    { token, target: 'E:/site/index.html' }
  );
});

test('path is recovered from URL segments, keeping the absolute root', () => {
  assert.strictEqual(parsePreviewUrl('/api/preview/E%3A/site/index.html', new Set()).target, 'E:/site/index.html');
  assert.strictEqual(parsePreviewUrl('/api/preview//var/www/index.html', new Set()).target, '/var/www/index.html');
  assert.strictEqual(parsePreviewUrl('/api/preview/my%20dir/a.html', new Set()).target, 'my dir/a.html');
});

test('a sibling resource URL decodes into the same directory', () => {
  // base /api/preview/<token>/E%3A/site/index.html + "style.css" resolves here
  assert.strictEqual(
    parsePreviewUrl('/api/preview/E%3A/site/style.css', new Set()).target,
    'E:/site/style.css'
  );
});

test('a file name that only looks like a base64url token stays part of the path', () => {
  const live = new Set(['onlythistokenislive']);
  assert.deepStrictEqual(
    parsePreviewUrl('/api/preview/averybase64urlishname/index.html', live),
    { token: null, target: 'averybase64urlishname/index.html' }
  );
});

test('trailing slash and empty remainder are handled', () => {
  assert.strictEqual(parsePreviewUrl('/api/preview/E%3A/site/', new Set()).target, 'E:/site');
  assert.strictEqual(parsePreviewUrl('/api/preview/', new Set()).target, '');
});

test('token grants access with the issuer privileges, never a higher ones', () => {
  const token = mintToken(false);
  // server runs with --terminal, token minted without it → must stay off
  assert.deepStrictEqual(authorizePreview(token, false, true), { ok: true, terminal: false });
  assert.deepStrictEqual(authorizePreview(mintToken(true), false, true), { ok: true, terminal: true });
});

test('a session cookie outranks the token and carries the live server flags', () => {
  assert.deepStrictEqual(authorizePreview(null, true, true), { ok: true, terminal: true });
});

test('unknown, missing and expired tokens are all refused', () => {
  assert.strictEqual(authorizePreview('neverminted', false, false).ok, false);
  assert.strictEqual(authorizePreview(null, false, false).ok, false);

  const token = mintToken(false);
  tokens.get(token).expires = Date.now() - 1;
  const res = authorizePreview(token, false, false);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'expired token');
  assert.ok(!tokens.has(token), 'an expired token is dropped on use');
});

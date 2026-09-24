// Integration smoke: boot the real server on an ephemeral-ish port and drive
// the critical paths over HTTP — auth gate, traversal regression, static
// caching/gzip, content search, and the PTY terminal round-trip.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 18800 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'itest-pw';
const ROOT = path.join(__dirname, '..');
let child = null;
let cookie = '';

/** Low-level GET keeping the raw path (fetch() would normalize '/../'). */
function rawGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'bin', 'edlics.js'), 'serve', '--port', String(PORT), '--password', PASSWORD], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/session');
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!ready) {
    const err = child.stderr ? '' : '';
    throw new Error('server did not become ready on port ' + PORT + err);
  }
});

after(() => {
  if (child) { try { child.kill(); } catch {} }
});

test('auth gate: 401 without session, login flow issues a working cookie', async () => {
  const anon = await fetchJson('/api/info');
  assert.strictEqual(anon.status, 401);

  const wrong = await fetchJson('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  assert.strictEqual(wrong.status, 401);

  const okLogin = await fetchJson('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  assert.strictEqual(okLogin.status, 200);
  const setCookie = okLogin.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('edlics_session='), 'session cookie must be set');
  assert.ok(setCookie.includes('HttpOnly'), 'cookie must be HttpOnly');
  cookie = setCookie.split(';')[0];

  const authed = await fetchJson('/api/info', { headers: { cookie } });
  assert.strictEqual(authed.status, 200);
  // spawned without --root so search/traversal cases can reach arbitrary paths
  assert.strictEqual(authed.data.root, false, 'no --root → root:false');
  assert.ok(authed.data.version, 'version present');
  assert.ok(!String(authed.data.home).includes('\\'), 'info.home must use POSIX separators');
});

test('static path traversal regression: /../ stays inside public/', async () => {
  const r = await rawGet('/../bin/edlics.js');
  const body = r.body.toString('utf-8');
  assert.ok(body.startsWith('<!DOCTYPE html>'), 'must fall back to SPA shell, got: ' + body.slice(0, 40));
  assert.ok(!body.includes('authPasswordHash'), 'must not leak backend source');

  const r2 = await rawGet('/../../etc/passwd');
  assert.ok(r2.body.toString('utf-8').startsWith('<!DOCTYPE html>'));
});

test('static serving: gzip offered, ETag revalidates with 304', async () => {
  const gz = await rawGet('/editor.mjs', { 'accept-encoding': 'gzip' });
  assert.strictEqual(gz.status, 200);
  assert.strictEqual(gz.headers['content-encoding'], 'gzip');
  assert.ok(gz.headers.etag, 'ETag present');
  assert.strictEqual(gz.headers['cache-control'], 'no-cache');

  const again = await rawGet('/editor.mjs', { 'if-none-match': gz.headers.etag });
  assert.strictEqual(again.status, 304);

  const plain = await rawGet('/css/style.css', { 'accept-encoding': 'identity' });
  assert.strictEqual(plain.status, 200);
  assert.ok(!plain.headers['content-encoding'], 'identity response is not compressed');
});

test('search-content: finds a needle in a temp workspace file (async path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-smoke-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first line\nneedle-here on line two\nthird\n');
    const r = await fetchJson('/api/search-content?path=' + encodeURIComponent(dir) + '&q=needle-here', { headers: { cookie } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.length, 1);
    assert.strictEqual(r.data[0].line, 2);
    assert.strictEqual(r.data[0].column, 1);
    assert.ok(r.data[0].text.includes('needle-here'));
    assert.ok(!r.data[0].path.includes('\\'), 'search results must use POSIX separators');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown api route → 404 (route table miss)', async () => {
  const r = await fetchJson('/api/definitely-not-a-route', { headers: { cookie } });
  assert.strictEqual(r.status, 404);
});

test('terminal PTY round-trip: open → stream echoes a command', async () => {
  const open = await fetchJson('/api/term/open', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ cols: 80, rows: 24, cwd: ROOT }),
  });
  assert.strictEqual(open.status, 200);
  assert.ok(open.data.ok);

  // Attach the stream and start reading in the background
  const controller = new AbortController();
  const streamRes = await fetch(BASE + '/api/term/stream', { headers: { cookie }, signal: controller.signal });
  assert.strictEqual(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let collected = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
        if (collected.includes('PTY_SMOKE_OK')) break;
      }
    } catch { /* aborted */ }
  })();

  await new Promise(r => setTimeout(r, 300));
  const input = await fetchJson('/api/term/input', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ data: 'echo PTY_SMOKE_OK\r' }),
  });
  assert.strictEqual(input.status, 200);

  const raced = await Promise.race([
    pump.then(() => collected.includes('PTY_SMOKE_OK')),
    new Promise(r => setTimeout(() => r(false), 8000)),
  ]);
  controller.abort();
  assert.ok(raced, 'PTY output must contain the echoed marker; got: ' + JSON.stringify(collected.slice(0, 300)));

  const close = await fetchJson('/api/term/close', { method: 'POST', headers: { cookie }, body: '{}' });
  assert.strictEqual(close.status, 200);
});

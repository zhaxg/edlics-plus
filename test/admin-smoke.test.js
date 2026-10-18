// Integration: the --admin panel — gating, info, health, audit, SSE stream,
// and SQLite-backed history. Also verifies the panel is OFF without --admin.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'admin-itest-pw';
const PORT = 19000 + (process.pid % 800);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let dataDir = null;
let cookie = '';

async function fetchJson(url, options = {}) {
  const res = await fetch(BASE + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function waitReady(base) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/session'); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-admin-'));
  child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'edlics.js'), 'serve',
    '--port', String(PORT), '--password', PASSWORD, '--admin',
    '--data-dir', dataDir,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!await waitReady(BASE)) throw new Error('admin server did not become ready on ' + PORT);
});

after(() => {
  if (child) { try { child.kill(); } catch {} }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }
});

test('admin gate: /api/sys/* needs auth, then works with a session', async () => {
  const anon = await fetchJson('/api/sys/info');
  assert.strictEqual(anon.status, 401);

  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.strictEqual(res.status, 200);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('edlics_session='));

  const info = await fetchJson('/api/sys/info', { headers: { cookie } });
  assert.strictEqual(info.status, 200);
  assert.ok(info.data.hostname, 'hostname present');
  assert.strictEqual(info.data.admin, true);
  assert.strictEqual(info.data.isRoot, true, 'running as root here');
  assert.ok(info.data.cores >= 1);
  assert.ok(info.data.memTotal > 0);
});

test('health reports RSS, event-loop delay and sampler state', async () => {
  const h = await fetchJson('/api/sys/health', { headers: { cookie } });
  assert.strictEqual(h.status, 200);
  assert.ok(h.data.rss > 0);
  assert.strictEqual(h.data.metricsRunning, true);
  assert.strictEqual(h.data.dbOpen, true);
  assert.ok(h.data.eventLoopDelay && typeof h.data.eventLoopDelay.mean === 'number');
});

test('audit trail records the successful login (persisted)', async () => {
  const a = await fetchJson('/api/sys/audit?limit=50', { headers: { cookie } });
  assert.strictEqual(a.status, 200);
  assert.ok(a.data.total >= 1);
  assert.ok(a.data.rows.some(r => r.action === 'login' && r.result === 'ok'), 'login row present');
});

test('metric history endpoint answers (empty before the first minute flush)', async () => {
  const m = await fetchJson('/api/sys/metrics?range=30m', { headers: { cookie } });
  assert.strictEqual(m.status, 200);
  assert.ok(Array.isArray(m.data.points));
  assert.strictEqual(m.data.step, 60);
});

test('SSE stream: sends the bootstrap history frame and live samples', async () => {
  const controller = new AbortController();
  const res = await fetch(BASE + '/api/sys/metrics/stream', { headers: { cookie }, signal: controller.signal });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !(text.includes('event: history') && text.includes('"cpu"'))) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.ok(text.includes('event: history'), 'bootstrap frame present: ' + JSON.stringify(text.slice(0, 120)));
  assert.ok(/"cpu"/.test(text), 'a sample with cpu field arrived');
});

test('admin panel is OFF without --admin (403, not 404)', async () => {
  const port2 = PORT + 1;
  const base2 = `http://127.0.0.1:${port2}`;
  const c2 = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'edlics.js'), 'serve', '--port', String(port2), '--password', PASSWORD,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    assert.ok(await waitReady(base2), 'plain server ready');
    const login = await fetch(base2 + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
    });
    const ck = (login.headers.get('set-cookie') || '').split(';')[0];
    const r = await fetch(base2 + '/api/sys/info', { headers: { cookie: ck } });
    assert.strictEqual(r.status, 403);
  } finally {
    try { c2.kill(); } catch {}
  }
});

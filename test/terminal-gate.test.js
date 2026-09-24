// Integration: the terminal is OFF by default and OFF under --readonly.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Keep this range disjoint from smoke.test.js (18800–19699) so the test
// files, which node --test runs in parallel child processes, never collide.
const BASE_PORT = 19700 + (process.pid % 100);
const P_DISABLED = BASE_PORT;
const P_READONLY = BASE_PORT + 1;
let childA = null;
let childB = null;

async function waitReady(port) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server not ready on ' + port);
}

async function login(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'gate-pw' }),
  });
  assert.strictEqual(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function openTerm(port, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}/api/term/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  childA = spawn(process.execPath, [path.join(ROOT, 'bin', 'edlics.js'), 'serve', '--port', String(P_DISABLED), '--password', 'gate-pw'], { cwd: ROOT, stdio: 'ignore' });
  childB = spawn(process.execPath, [path.join(ROOT, 'bin', 'edlics.js'), 'serve', '--port', String(P_READONLY), '--password', 'gate-pw', '--terminal', '--readonly'], { cwd: ROOT, stdio: 'ignore' });
  await Promise.all([waitReady(P_DISABLED), waitReady(P_READONLY)]);
});

after(() => {
  for (const c of [childA, childB]) { if (c) { try { c.kill(); } catch {} } }
});

test('default (no --terminal): term routes403, info.terminal=false', async () => {
  const cookie = await login(P_DISABLED);
  const opened = await openTerm(P_DISABLED, cookie);
  assert.strictEqual(opened.status, 403);
  assert.match(opened.body.error, /disabled/i);

  const info = await fetch(`http://127.0.0.1:${P_DISABLED}/api/info`, { headers: { cookie } }).then(r => r.json());
  assert.strictEqual(info.terminal, false);
  assert.strictEqual(info.readonly, false);
});

test('--terminal --readonly: readonly wins, terminal stays off', async () => {
  const cookie = await login(P_READONLY);
  const opened = await openTerm(P_READONLY, cookie);
  assert.strictEqual(opened.status, 403);
  assert.match(opened.body.error, /disabled/i);

  const info = await fetch(`http://127.0.0.1:${P_READONLY}/api/info`, { headers: { cookie } }).then(r => r.json());
  assert.strictEqual(info.terminal, false);
  assert.strictEqual(info.readonly, true);
});

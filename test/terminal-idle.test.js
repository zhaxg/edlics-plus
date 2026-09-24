// Unit tests: PTY idle sweep (P0 — shells must not outlive idle tabs).
const { test } = require('node:test');
const assert = require('node:assert');
const { sweepIdle, termSessions, TERM_IDLE_MS } = require('../bin/lib/terminal-api');

test('sweepIdle: fresh sessions survive, idle sessions are killed and removed', () => {
  const now = Date.now();
  let freshKilled = false;
  let idleKilled = false;

  termSessions.set('fresh', {
    pty: { kill: () => { freshKilled = true; } },
    parts: [], len: 0, stream: null, exited: false, cwd: '/', lastActivity: now,
  });
  termSessions.set('idle', {
    pty: { kill: () => { idleKilled = true; } },
    parts: [], len: 0, stream: null, exited: false, cwd: '/', lastActivity: now - (TERM_IDLE_MS + 1000),
  });
  termSessions.set('exited', {
    pty: { kill: () => { throw new Error('must not kill twice'); } },
    parts: [], len: 0, stream: null, exited: true, cwd: '/', lastActivity: now,
  });

  sweepIdle(now);

  assert.ok(!freshKilled, 'fresh session must survive');
  assert.ok(idleKilled, 'idle session must be killed');
  assert.ok(termSessions.has('fresh'));
  assert.ok(!termSessions.has('idle'));
  assert.ok(!termSessions.has('exited'), 'exited sessions are garbage-collected');

  termSessions.delete('fresh');
});

test('TERM_IDLE_MS is 30 minutes', () => {
  assert.strictEqual(TERM_IDLE_MS, 30 * 60 * 1000);
});

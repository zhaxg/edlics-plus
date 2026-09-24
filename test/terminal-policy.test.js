// Unit tests: terminal input policy — multi-line rejection, high-risk
// Enter-boundary denylist (anti foot-cannon), best-effort line tracking.
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInput, checkHighRisk, trackLine } = require('../bin/lib/terminal-api');

test('classifyInput: bare Enter, typed line+Enter, pure typing', () => {
  assert.deepStrictEqual(classifyInput('\r'), { action: 'pass', body: '', term: '\r' });
  assert.deepStrictEqual(classifyInput('echo hi\r'), { action: 'pass', body: 'echo hi', term: '\r' });
  assert.deepStrictEqual(classifyInput('echo hi\n'), { action: 'pass', body: 'echo hi', term: '\n' });
  assert.deepStrictEqual(classifyInput('ls -la'), { action: 'pass', body: 'ls -la', term: '' });
  assert.deepStrictEqual(classifyInput('\r\n'), { action: 'pass', body: '', term: '\r\n' });
});

test('classifyInput: multi-line payloads are rejected (nothing forwarded)', () => {
  assert.strictEqual(classifyInput('cmd1\rcmd2').action, 'reject');
  assert.strictEqual(classifyInput('cmd1\r\ncmd2').action, 'reject');
  assert.strictEqual(classifyInput('a\nb\nc').action, 'reject');
  assert.strictEqual(classifyInput('npm run build\rrm -rf /').action, 'reject');
});

test('checkHighRisk: disasters blocked at Enter boundary', () => {
  const blocked = [
    'rm -rf /',
    'sudo rm -rf /',
    'rm -fr ~',
    'rm -rf /*',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'reboot',
    ':(){ :|:& };:',
    'chmod -R 777 /',
    'rd /s /q C:\\',
    'format D:',
  ];
  for (const line of blocked) {
    assert.ok(checkHighRisk(line), `should block: ${line}`);
  }
});

test('checkHighRisk: normal commands pass', () => {
  const allowed = [
    'ls -la /',
    'rm -rf build',
    'rm -rf dist/*',
    'git status',
    'git push --force',
    'npm run build',
    'echo shutdown now',
    'dd if=backup.img of=copy.img',
    'shutdown-node --version',
    'rd /s /q tempdir',
  ];
  for (const line of allowed) {
    assert.strictEqual(checkHighRisk(line), null, `should allow: ${line}`);
  }
});

test('trackLine: typing, backspace, history recall, Ctrl+C reset', () => {
  let buf = '';
  buf = trackLine(buf, 'git st', '');
  assert.strictEqual(buf, 'git st');
  buf = trackLine(buf, '\x7f\x7f', '');
  assert.strictEqual(buf, 'git '); // 'git st' minus 2 backspaces
  buf = trackLine(buf, '\x1b[A', 'git log');   // ↑ recalls last submit
  assert.strictEqual(buf, 'git log');
  buf = trackLine(buf, '\x1b[B', 'git log');   // ↓ clears
  assert.strictEqual(buf, '');
  buf = trackLine(buf, 'rm -rf /', '');
  buf = trackLine(buf, '\x03more', '');         // Ctrl+C resets, then types
  assert.strictEqual(buf, 'more');
});

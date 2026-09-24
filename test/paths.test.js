// Unit tests: path safety primitives (root containment, symlinks).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setRootDir, isWithinRoot, isPathSafe } = require('../bin/lib/paths');

test('isWithinRoot: base itself and descendants pass, siblings/escapes fail', () => {
  const base = path.resolve(path.sep + 'proj');
  assert.ok(isWithinRoot(base, base));
  assert.ok(isWithinRoot(base, path.join(base, 'a')));
  assert.ok(isWithinRoot(base, path.join(base, 'a', 'b.txt')));
  assert.ok(!isWithinRoot(base, path.join(base, '..', 'other')));
  assert.ok(!isWithinRoot(base, path.join(base, 'a', '..', '..', 'other')));
  assert.ok(!isWithinRoot(base, path.resolve(path.sep + 'other')));
});

test('isPathSafe: no root configured → everything allowed', () => {
  setRootDir(null);
  assert.ok(isPathSafe(path.sep + 'anywhere'));
});

test('isPathSafe: with root → inside ok, outside denied', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setRootDir(root);
  assert.ok(isPathSafe(path.join(root, 'file.txt')));
  // parent dir does not exist → realpath fails → deny (matches server behavior)
  assert.ok(!isPathSafe(path.join(root, 'nested', 'deep', 'file.txt')));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-outside-'));
  try {
    assert.ok(!isPathSafe(path.join(outside, 'file.txt')));
    assert.ok(!isPathSafe(path.resolve(root, '..', path.basename(outside), 'file.txt')));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    setRootDir(null);
  }
});

test('isPathSafe: symlink escaping the root is rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-symroot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-symsrc-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    setRootDir(null);
  });
  const link = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction'); // junction needs no admin on Windows
  } catch {
    t.skip('symlink creation not permitted in this environment');
    return;
  }
  setRootDir(root);
  assert.ok(!isPathSafe(link), 'symlink to outside must be rejected');
  // …while a real child stays allowed
  fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
  assert.ok(isPathSafe(path.join(root, 'ok.txt')));
  setRootDir(null);
});

// Unit tests: pure git output parsers (fixtures, no git binary needed).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStatusZ, parseLog, parseCommitFilesZ } = require('../bin/lib/git-api');

test('parseStatusZ: branch + modified/untracked/rename entries', () => {
  const out =
    '## main...origin/main\0' +
    ' M bin/edlics.js\0' +
    '?? newdir/\0' +
    'R  new-name.js\0old-name.js\0' +
    'A  staged.txt\0';
  const { branch, changes } = parseStatusZ(out);
  assert.strictEqual(branch, 'main');
  assert.deepStrictEqual(changes, [
    { xy: ' M', path: 'bin/edlics.js' },
    { xy: '??', path: 'newdir/' },
    { xy: 'R ', path: 'new-name.js' }, // old path consumed, not listed
    { xy: 'A ', path: 'staged.txt' },
  ]);
});

test('parseStatusZ: no-commits-yet and detached styles', () => {
  assert.strictEqual(parseStatusZ('## No commits yet on main\0').branch, 'main');
  assert.strictEqual(parseStatusZ('## Initial commit on dev\0').branch, 'dev');
  assert.strictEqual(parseStatusZ('## main\0').branch, 'main');
  assert.deepStrictEqual(parseStatusZ('## main\0').changes, []);
});

test('parseLog: unit-separator fields, subject may contain the separator', () => {
  const out = [
    'aaaa\x1fabc123\x1fAlice\x1f2026-09-01T00:00:00+08:00\x1ffix: handle\x1fweird subject',
    'bbbb\x1fdef456\x1fBob\x1f2026-09-02T00:00:00+08:00\x1ffeat: add thing',
  ].join('\n');
  const commits = parseLog(out);
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(commits[0].subject, 'fix: handle\x1fweird subject');
  assert.strictEqual(commits[0].author, 'Alice');
  assert.strictEqual(commits[1].short, 'def456');
  assert.deepStrictEqual(parseLog(''), []);
});

test('parseCommitFilesZ: alternating status/path pairs, junk skipped', () => {
  const out = 'M\0bin/a.js\0A\0new.txt\0D\0gone.md\0';
  assert.deepStrictEqual(parseCommitFilesZ(out), [
    { status: 'M', path: 'bin/a.js' },
    { status: 'A', path: 'new.txt' },
    { status: 'D', path: 'gone.md' },
  ]);
  assert.deepStrictEqual(parseCommitFilesZ(''), []);
});

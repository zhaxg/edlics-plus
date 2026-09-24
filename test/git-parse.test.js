// Unit tests: pure git output parsers (fixtures, no git binary needed).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStatusZ, parseLog, parseCommitFilesZ, toWebUrl, newFileDiff } = require('../bin/lib/git-api');

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

test('toWebUrl: ssh forms become browsable https, http(s) kept, junk passthrough', () => {
  // scp-like ssh
  assert.strictEqual(toWebUrl('git@github.com:zhaxg/edlics-plus.git'), 'https://github.com/zhaxg/edlics-plus');
  assert.strictEqual(toWebUrl('git@gitlab.com:group/sub/repo'), 'https://gitlab.com/group/sub/repo');
  // ssh:// with optional user/port
  assert.strictEqual(toWebUrl('ssh://git@github.com/zhaxg/edlics-plus.git'), 'https://github.com/zhaxg/edlics-plus');
  assert.strictEqual(toWebUrl('ssh://git@example.com:2222/repo.git'), 'https://example.com/repo');
  // git:// protocol
  assert.strictEqual(toWebUrl('git://github.com/zhaxg/edlics-plus.git'), 'https://github.com/zhaxg/edlics-plus');
  // existing http(s): kept (only .git suffix stripped)
  assert.strictEqual(toWebUrl('https://github.com/zhaxg/edlics-plus.git'), 'https://github.com/zhaxg/edlics-plus');
  assert.strictEqual(toWebUrl('http://example.com/repo.git'), 'http://example.com/repo');
  // empty → null; unknown/local → passthrough
  assert.strictEqual(toWebUrl(''), null);
  assert.strictEqual(toWebUrl('  '), null);
  assert.strictEqual(toWebUrl('/srv/local/repo'), '/srv/local/repo');
});

test('newFileDiff: untracked file rendered as all-added unified diff', () => {
  const d = newFileDiff('src/new.js', Buffer.from('line1\nline2\n'));
  assert.match(d, /^diff --git a\/src\/new\.js b\/src\/new\.js\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/new\.js\n/);
  assert.match(d, /@@ -0,0 \+1,2 @@\n\+line1\n\+line2\n/);
  // no trailing newline → marker line
  const d2 = newFileDiff('x.txt', Buffer.from('abc'));
  assert.match(d2, /\+abc\n\\ No newline at end of file\n$/);
  // empty file → header only (git shows no hunk)
  assert.strictEqual(newFileDiff('empty.txt', Buffer.from('')).split('@@').length, 1);
  // binary (NUL byte) → notice, not garbage lines
  const d3 = newFileDiff('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.match(d3, /Binary file img\.bin \(new\)/);
});

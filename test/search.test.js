// Unit tests: pure content-search matcher + binary sniffing + excludes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectMatches } = require('../bin/lib/search-api');
const { detectFileType, getExcludes } = require('../bin/lib/paths');

test('collectMatches: line/column, multi-hit per line, case handling, cap', () => {
  const content = 'alpha beta alpha\ngamma\nALPHA\n';
  // case-insensitive (needle pre-lowercased by the caller)
  const hits = collectMatches('/f.txt', content, 'alpha', false, 100);
  assert.deepStrictEqual(hits.map(h => [h.line, h.column]), [[1, 1], [1, 12], [3, 1]]);
  // case-sensitive skips line 3
  const cs = collectMatches('/f.txt', content, 'alpha', true, 100);
  assert.deepStrictEqual(cs.map(h => h.line), [1, 1]);
  // cap stops early
  assert.strictEqual(collectMatches('/f.txt', content, 'a', false, 2).length, 2);
  // empty needle / no hit
  assert.deepStrictEqual(collectMatches('/f.txt', content, '', false, 10), []);
  assert.deepStrictEqual(collectMatches('/f.txt', content, 'zzz', false, 10), []);
});

test('detectFileType: common magics', () => {
  assert.strictEqual(detectFileType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D])), 'PNG image');
  assert.strictEqual(detectFileType(Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02])), 'ELF executable (64-bit)');
  assert.strictEqual(detectFileType(Buffer.from([0x4D, 0x5A, 0x90, 0x00])), 'Windows executable (PE)');
  assert.strictEqual(detectFileType(Buffer.from('GIF89a-rest')), 'GIF image');
  assert.strictEqual(detectFileType(Buffer.from([0x00])), 'Unknown file'); // shorter than 4 bytes
  assert.strictEqual(detectFileType(Buffer.from([0x25, 0x50, 0x44, 0x46])), 'PDF document');
});

test('getExcludes: package.json project excludes node_modules, strangers excluded too', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-ex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const ex = getExcludes(dir);
  assert.ok(ex.has('node_modules'));
  assert.ok(ex.has('.git'));
  assert.ok(!ex.has('src'));
  // no marker files → only BASE_EXCLUDE
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'edlics-ex2-'));
  try {
    const ex2 = getExcludes(plain);
    assert.ok(ex2.has('.git') && !ex2.has('node_modules'));
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

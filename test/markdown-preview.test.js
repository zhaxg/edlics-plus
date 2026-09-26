// Unit tests: markdown preview image src resolution (the relative-path bug).
const { test } = require('node:test');
const assert = require('node:assert');

// markdown-preview.mjs is browser ESM; only the pure resolver is exercised here.
const { resolveImgSrc, buildPreviewUrl } = require('../public/js/markdown-preview.mjs');

test('preview URL keeps token + path in URL segments (relative assets must resolve)', () => {
  assert.strictEqual(
    buildPreviewUrl('E:/proj/site/index.html', 'tok123'),
    '/api/preview/tok123/E%3A/proj/site/index.html'
  );
  assert.strictEqual(buildPreviewUrl('/var/www/index.html', 'tok123'), '/api/preview/tok123//var/www/index.html');
  // windows backslashes normalize to forward ones
  assert.strictEqual(
    buildPreviewUrl('C:\\site\\a b.html', 'tok123'),
    '/api/preview/tok123/C%3A/site/a%20b.html'
  );
});

test('relative image resolves against the markdown file directory', () => {
  const md = 'E:/proj/docs/README.md';
  assert.strictEqual(
    resolveImgSrc('screenshots/hero.png', md),
    '/api/download?path=' + encodeURIComponent('E:/proj/docs/screenshots/hero.png')
  );
  assert.strictEqual(
    resolveImgSrc('./img/a.png', md),
    '/api/download?path=' + encodeURIComponent('E:/proj/docs/img/a.png')
  );
  assert.strictEqual(
    resolveImgSrc('../logo.png', md),
    '/api/download?path=' + encodeURIComponent('E:/proj/logo.png') // normalized
  );
});

test('absolute server / windows paths are passed through to download', () => {
  assert.strictEqual(
    resolveImgSrc('/var/data/pic.png', 'E:/proj/README.md'),
    '/api/download?path=' + encodeURIComponent('/var/data/pic.png')
  );
  assert.strictEqual(
    resolveImgSrc('E:\\assets\\logo.png', 'E:/proj/README.md'),
    '/api/download?path=' + encodeURIComponent('E:/assets/logo.png')
  );
});

test('data URIs, external URLs and api endpoints stay untouched', () => {
  assert.strictEqual(resolveImgSrc('data:image/png;base64,xxxx', 'E:/a.md'), 'data:image/png;base64,xxxx');
  assert.strictEqual(resolveImgSrc('https://cdn.example/x.png', 'E:/a.md'), 'https://cdn.example/x.png');
  assert.strictEqual(resolveImgSrc('//cdn.example/x.png', 'E:/a.md'), '//cdn.example/x.png');
  assert.strictEqual(resolveImgSrc('/api/download?path=E:/x.png', 'E:/a.md'), '/api/download?path=E:/x.png');
});

test('missing context or empty src leaves input unchanged', () => {
  assert.strictEqual(resolveImgSrc('pic.png', ''), 'pic.png');
  assert.strictEqual(resolveImgSrc('', 'E:/a.md'), '');
});

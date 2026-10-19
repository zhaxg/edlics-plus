// Frontend architecture guards.
//
// The console pages moved from hand-written innerHTML rendering to Preact +
// htm (views/*.mjs). These tests keep the migration honest as features are
// added: no HTML string concatenation in views, no duplicate module imports,
// and the prebuilt framework bundle must still export what the app imports.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VIEWS = path.join(PUBLIC, 'js', 'views');

const read = p => fs.readFileSync(p, 'utf8');
const viewFiles = () => fs.readdirSync(VIEWS).filter(f => f.endsWith('.mjs'));

test('views/ has the four console pages', () => {
  const names = viewFiles().sort();
  assert.deepStrictEqual(names, ['containers.mjs', 'dashboard.mjs', 'system.mjs', 'terminal.mjs']);
});

test('views are Preact components importing only shared modules', () => {
  const allowed = new Set(['/ui.mjs', '/charts.mjs', '/qr.mjs']);
  for (const f of viewFiles()) {
    const src = read(path.join(VIEWS, f));
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(imports.includes('/ui.mjs'), `${f} must import the Preact bundle`);
    for (const spec of imports) {
      const ok = allowed.has(spec) || spec.startsWith('../') || spec.startsWith('./');
      assert.ok(ok, `${f} imports unexpected module ${spec}`);
    }
  }
});

test('views use no innerHTML string building', () => {
  for (const f of viewFiles()) {
    const src = read(path.join(VIEWS, f));
    // dangerouslySetInnerHTML is allowed only for the QR code SVG (trusted,
    // generated locally by qrcode); innerHTML assignment never is.
    const htmlAssign = /\.innerHTML\s*=/.test(src);
    assert.ok(!htmlAssign, `${f} assigns innerHTML — render with html\`\` instead`);
    const unescaped = (src.match(/dangerouslySetInnerHTML/g) || []).length;
    if (unescaped) assert.match(f, /dashboard/, 'dangerouslySetInnerHTML is only expected in the 2FA QR block');
  }
});

test('every console page is registered in the shell', () => {
  const shell = read(path.join(PUBLIC, 'js', 'shell.mjs'));
  for (const f of viewFiles()) {
    const name = f.replace(/\.mjs$/, '');
    assert.ok(new RegExp(`from '\\./views/${name}\\.mjs'`).test(shell), `${name} is not imported by shell.mjs`);
  }
  // Old imperative modules must be gone (they were replaced by views/).
  for (const gone of ['overview.mjs', 'services.mjs', 'network.mjs', 'users.mjs',
    'disk.mjs', 'cron.mjs', 'logs.mjs', 'containers.mjs', 'processes.mjs', 'activity.mjs']) {
    assert.ok(!fs.existsSync(path.join(PUBLIC, 'js', gone)), `${gone} should be deleted`);
  }
});

test('prebuilt bundles export what the app imports', async () => {
  const required = {
    'public/ui.mjs': ['h', 'html', 'render', 'Fragment', 'createPortal',
      'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext'],
    'public/charts.mjs': ['uPlot'],
    'public/qr.mjs': ['qrSvg'],
  };
  for (const [file, names] of Object.entries(required)) {
    const mod = await import(pathToFileURL(path.join(ROOT, file)).href);
    for (const n of names) assert.ok(n in mod, `${file} does not export ${n}`);
  }
});

test('index.html keeps the IDE mount points and a Preact console host', () => {
  const html = read(path.join(PUBLIC, 'index.html'));
  for (const id of ['railHost', 'consoleArea', 'sidebar', 'editorArea', 'tabs', 'loginOverlay', 'dialogOverlay']) {
    assert.ok(html.includes(`id="${id}"`), `index.html lost #${id}`);
  }
  // The old hand-written console pages are rendered by Preact now.
  for (const gone of ['page-overview', 'page-services', 'page-containers', 'page-terminal']) {
    assert.ok(!html.includes(`id="${gone}"`), `index.html still contains #${gone}`);
  }
});

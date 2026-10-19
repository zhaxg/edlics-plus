// check-bundles.mjs — assert that every prebuilt browser bundle still exports
// what public/js/*.mjs imports. Guards against a minifier silently dropping a
// binding (which shows up as "does not provide an export named …" at runtime).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const REQUIRED = {
  'public/ui.mjs': ['h', 'html', 'render', 'Fragment', 'createPortal',
    'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext'],
  'public/charts.mjs': ['uPlot'],
  'public/qr.mjs': ['qrSvg'],
};

let failed = false;
for (const [file, names] of Object.entries(REQUIRED)) {
  let mod;
  try {
    mod = await import(pathToFileURL(resolve(file)).href);
  } catch (e) {
    console.error(`✗ ${file}: failed to load — ${e.message}`);
    failed = true;
    continue;
  }
  const missing = names.filter(n => !(n in mod));
  if (missing.length) {
    console.error(`✗ ${file}: missing exports ${missing.join(', ')}`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${names.length} exports`);
  }
}

if (failed) {
  console.error('\nBundle export check failed — run `npm run build` again.');
  process.exit(1);
}

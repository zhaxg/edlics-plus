// Icon manifest ↔ SVG consistency: public/icon-manifest.json is generated from
// the vscode-material-icon-theme source while public/icons/*.svg are copied
// from the same theme, so the two can drift. A manifest entry with no file
// makes the frontend request /icons/<id>.svg, get a 404 and render a blank
// icon slot (img.onerror hides it).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'icon-manifest.json'), 'utf8'));
const have = new Set(
  fs.readdirSync(path.join(ROOT, 'public', 'icons'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.slice(0, -4))
);

// Ids public/js/icons.mjs can actually request
function usedIconIds() {
  const ids = new Set([manifest.file, manifest.folder, manifest.rootFolder]);
  for (const table of ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded']) {
    for (const id of Object.values(manifest[table] || {})) ids.add(id);
  }
  return ids;
}

test('every icon id in icon-manifest.json has an SVG in public/icons', () => {
  const missing = [...usedIconIds()].filter((id) => !have.has(id));
  assert.deepStrictEqual(missing, [], `missing SVGs: ${missing.join(', ')}`);
});

test('folder name lookups resolve to shipped icons', () => {
  // Regression: a `development/` folder mapped to folder-development.svg which
  // was never copied into public/icons.
  for (const name of ['development', 'src', 'components', 'node_modules']) {
    const id = manifest.folderNames[name];
    if (!id) continue;
    assert.ok(have.has(id), `folder "${name}" -> /icons/${id}.svg is missing`);
  }
  assert.strictEqual(manifest.folderNames.development, 'folder-development');
  assert.ok(have.has('folder-development'));
});

test('generic fallback icons exist', () => {
  assert.ok(have.has(manifest.folder), `default folder icon ${manifest.folder}.svg missing`);
  assert.ok(have.has(manifest.file), `default file icon ${manifest.file}.svg missing`);
});

test('variant files resolve through their base name', async () => {
  const { setIconManifest } = await import('../public/js/state.mjs');
  const { getFileIcon } = await import('../public/js/icons.mjs');
  setIconManifest(manifest);

  // The theme enumerates dockerfile.dev/.prod/.ci/.web/… but not .api, so
  // "Dockerfile.api" used to fall through to the generic file icon.
  assert.strictEqual(getFileIcon('Dockerfile.api', false), 'docker');
  assert.strictEqual(getFileIcon('Dockerfile.web', false), 'docker');
  assert.strictEqual(getFileIcon('Dockerfile.api.local', false), 'docker');
  assert.strictEqual(getFileIcon('dockerfile.staging', false), 'docker');

  // Known extensions still win over the base-name walk-back
  assert.strictEqual(getFileIcon('dockerfile.yml', false), manifest.fileExtensions.yml);

  // Unknown names keep the generic file icon (no bogus base match)
  assert.strictEqual(getFileIcon('nothing.here', false), manifest.file);
});

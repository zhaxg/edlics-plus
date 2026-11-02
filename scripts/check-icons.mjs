#!/usr/bin/env node
/**
 * check-icons.mjs — Verify every icon id referenced by public/icon-manifest.json
 * has a matching SVG in public/icons.
 *
 * The manifest is generated from the vscode-material-icon-theme source
 * (bundle/build-icons.mjs) while the SVGs are copied from the same theme, so
 * the two can drift apart: a manifest entry without a file makes the frontend
 * request /icons/<id>.svg, get a 404 and render no icon at all.
 *
 * Usage: node scripts/check-icons.mjs   (npm run check:icons)
 */

import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST = join(ROOT, 'public', 'icon-manifest.json');
const ICONS = join(ROOT, 'public', 'icons');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
const have = new Set(readdirSync(ICONS).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));

// Icon ids the frontend can actually request (public/js/icons.mjs)
const ids = new Set([manifest.file, manifest.folder, manifest.rootFolder]);
for (const table of ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded']) {
  for (const id of Object.values(manifest[table] || {})) ids.add(id);
}

const missing = [...ids].filter((id) => !have.has(id)).sort();

if (missing.length) {
  console.error(`✗ ${missing.length} icon id(s) in icon-manifest.json have no SVG in public/icons:`);
  for (const id of missing) console.error(`    /icons/${id}.svg`);
  console.error('\nCopy them from vscode-material-icon-theme (icons/), e.g.:');
  console.error('  node bundle/build-icons.mjs [path-to-source]   # regenerate manifest');
  process.exit(1);
}

console.log(`✓ all ${ids.size} icon ids in icon-manifest.json have an SVG in public/icons`);

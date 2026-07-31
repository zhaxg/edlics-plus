#!/usr/bin/env node
/**
 * build-icons.mjs — Self-contained icon manifest builder for Edlics.
 *
 * Reads fileIcons.ts and folderIcons.ts from the vscode-material-icon-theme
 * SOURCE directory (not npm package), extracts icon definitions via regex,
 * applies pattern expansion and folder name extension, then outputs:
 *   public/icon-manifest.json  — lookup tables for the frontend
 *
 * Usage:
 *   node bundle/build-icons.mjs [path-to-source]
 *
 * Default: ../vscode-material-icon-theme
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(process.argv[2] || join(__dirname, '..', '..', 'vscode-material-icon-theme'));
const OUT = join(__dirname, '..', 'public', 'icon-manifest.json');

// ─── Pattern expansion (copied from material-icon-theme/src/patterns/patterns.ts) ───

const PATTERN_EXPANDERS = {
  ecmascript: (n) => [`${n}.js`, `${n}.mjs`, `${n}.cjs`, `${n}.ts`, `${n}.mts`, `${n}.cts`],
  configuration: (n) => [`${n}.json`, `${n}.jsonc`, `${n}.json5`, `${n}.yaml`, `${n}.yml`, `${n}.toml`],
  nodeEcosystem: (n) => [
    `${n}.js`, `${n}.mjs`, `${n}.cjs`, `${n}.ts`, `${n}.mts`, `${n}.cts`,
    `${n}.json`, `${n}.jsonc`, `${n}.json5`, `${n}.yaml`, `${n}.yml`, `${n}.toml`,
  ],
  cosmiconfig: (n) => [
    `.${n}rc`, `.${n}rc.json`, `.${n}rc.jsonc`, `.${n}rc.json5`,
    `.${n}rc.yaml`, `.${n}rc.yml`, `.${n}rc.toml`,
    `.${n}rc.js`, `.${n}rc.mjs`, `.${n}rc.cjs`,
    `.${n}rc.ts`, `.${n}rc.mjs`, `.${n}rc.cts`,
    `.config/${n}rc`, `.config/${n}rc.json`, `.config/${n}rc.jsonc`,
    `.config/${n}rc.json5`, `.config/${n}rc.yaml`, `.config/${n}rc.yml`,
    `.config/${n}rc.toml`, `.config/${n}rc.js`, `.config/${n}rc.mjs`,
    `.config/${n}rc.cjs`, `.config/${n}rc.ts`, `.config/${n}rc.mts`,
    `.config/${n}rc.cts`,
    `${n}.config.json`, `${n}.config.jsonc`, `${n}.config.json5`,
    `${n}.config.yaml`, `${n}.config.yml`, `${n}.config.toml`,
    `${n}.config.js`, `${n}.config.mjs`, `${n}.config.cjs`,
    `${n}.config.ts`, `${n}.config.mts`, `${n}.config.cts`,
  ],
  yaml: (n) => [`${n}.yaml`, `${n}.yml`],
  dotfile: (n) => [`.${n}`, n],
};

function expandFileNames(fileNames, patterns) {
  const result = [...fileNames];
  if (patterns) {
    for (const [key, pattern] of Object.entries(patterns)) {
      const expander = PATTERN_EXPANDERS[pattern];
      if (expander) result.push(...expander(key));
    }
  }
  return result;
}

// ─── Folder name extension (copied from folderGenerator.ts extendFolderNames) ───

function extendFolderNames(names) {
  const result = [];
  for (const name of names) {
    result.push(name);           // src
    result.push('.' + name);     // .src
    result.push('_' + name);     // _src
    result.push('-' + name);     // -src
    result.push('__' + name + '__'); // __src__
  }
  return result;
}

// ─── Parse fileIcons.ts (extract icon definitions via regex) ───

function parseFileIcons() {
  const src = readFileSync(join(SOURCE, 'src/core/icons/fileIcons.ts'), 'utf-8');

  // Split into icon blocks by matching each { name: '...', ... } at the top level
  const icons = [];
  let depth = 0, blockStart = -1;
  let inArray = false;

  // Find the main icons array
  const arrayStart = src.indexOf('parseByPattern([');
  if (arrayStart === -1) {
    // Fallback: no parseByPattern, try direct array
    const altStart = src.indexOf('icons: [');
    if (altStart === -1) throw new Error('Cannot find icon definitions in fileIcons.ts');
  }

  // Simple block extraction: find each { name: '...' } block
  const blockRegex = /\{\s*name\s*:\s*'([^']+)'/g;
  let match;
  const seen = new Set();

  while ((match = blockRegex.exec(src)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);

    // Find the matching closing brace
    const startIdx = match.index;
    let braceDepth = 0;
    let endIdx = startIdx;
    let foundOpen = false;
    for (let i = startIdx; i < src.length; i++) {
      if (src[i] === '{') { braceDepth++; foundOpen = true; }
      if (src[i] === '}') { braceDepth--; }
      if (foundOpen && braceDepth === 0) { endIdx = i; break; }
    }

    const block = src.slice(startIdx, endIdx + 1);

    // Extract fileExtensions
    const extMatch = block.match(/fileExtensions\s*:\s*\[([\s\S]*?)\]/);
    const fileExtensions = extMatch
      ? (extMatch[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1))
      : [];

    // Extract fileNames
    const fnMatch = block.match(/fileNames\s*:\s*\[([\s\S]*?)\]/);
    const fileNames = fnMatch
      ? (fnMatch[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1))
      : [];

    // Extract patterns
    const patMatch = block.match(/patterns\s*:\s*\{([\s\S]*?)\}/);
    const patterns = {};
    if (patMatch) {
      const entries = patMatch[1].match(/'([^']+)'\s*:\s*(\w+)/g) || [];
      for (const e of entries) {
        const m = e.match(/'([^']+)'\s*:\s*(\w+)/);
        if (m) patterns[m[1]] = m[2];
      }
    }

    if (fileExtensions.length || fileNames.length || Object.keys(patterns).length) {
      icons.push({ name, fileExtensions, fileNames, patterns });
    }
  }

  // Default icon
  const defMatch = src.match(/defaultIcon\s*:\s*\{\s*name\s*:\s*'([^']+)'/);
  return { defaultIcon: defMatch ? defMatch[1] : 'file', icons };
}

// ─── Parse folderIcons.ts ───

function parseFolderIcons() {
  const src = readFileSync(join(SOURCE, 'src/core/icons/folderIcons.ts'), 'utf-8');

  const icons = [];
  const blockRegex = /\{\s*name\s*:\s*'([^']+)'/g;
  let match;
  const seen = new Set();

  while ((match = blockRegex.exec(src)) !== null) {
    const name = match[1];
    if (seen.has(name) || !name.startsWith('folder-')) continue;
    seen.add(name);

    const startIdx = match.index;
    let braceDepth = 0, endIdx = startIdx, foundOpen = false;
    for (let i = startIdx; i < src.length; i++) {
      if (src[i] === '{') { braceDepth++; foundOpen = true; }
      if (src[i] === '}') { braceDepth--; }
      if (foundOpen && braceDepth === 0) { endIdx = i; break; }
    }
    const block = src.slice(startIdx, endIdx + 1);

    const fnMatch = block.match(/folderNames\s*:\s*\[([\s\S]*?)\]/);
    const folderNames = fnMatch
      ? (fnMatch[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1))
      : [];

    if (folderNames.length) icons.push({ name, folderNames });
  }

  const defMatch = src.match(/defaultIcon\s*:\s*\{\s*name\s*:\s*'([^']+)'/);
  const rootMatch = src.match(/rootFolder\s*:\s*\{\s*name\s*:\s*'([^']+)'/);
  return {
    defaultIcon: defMatch ? defMatch[1] : 'folder',
    rootIcon: rootMatch ? rootMatch[1] : 'folder-root',
    icons,
  };
}

// ─── Build manifest ───

function buildManifest() {
  console.log(`Reading source from: ${SOURCE}`);

  console.log('Parsing fileIcons.ts...');
  const fileIcons = parseFileIcons();
  console.log(`  ${fileIcons.icons.length} icon definitions (default: ${fileIcons.defaultIcon})`);

  console.log('Parsing folderIcons.ts...');
  const folderIcons = parseFolderIcons();
  console.log(`  ${folderIcons.icons.length} folder definitions (default: ${folderIcons.defaultIcon})`);

  const manifest = {
    file: fileIcons.defaultIcon,
    folder: folderIcons.defaultIcon,
    rootFolder: folderIcons.rootIcon,
    fileNames: {},
    fileExtensions: {},
    folderNames: {},
    folderNamesExpanded: {},
  };

  // File icons: fileNames then fileExtensions
  for (const icon of fileIcons.icons) {
    const allNames = expandFileNames(icon.fileNames, icon.patterns);
    for (const fn of allNames) {
      manifest.fileNames[fn.toLowerCase()] = icon.name;
    }
    for (const ext of icon.fileExtensions) {
      manifest.fileExtensions[ext.toLowerCase()] = icon.name;
    }
  }

  // Folder icons
  for (const icon of folderIcons.icons) {
    const extended = extendFolderNames(icon.folderNames);
    for (const fn of extended) {
      manifest.folderNames[fn.toLowerCase()] = icon.name;
      manifest.folderNamesExpanded[fn.toLowerCase()] = icon.name + '-open';
    }
  }

  console.log(`\nManifest:`);
  console.log(`  fileNames:       ${Object.keys(manifest.fileNames).length}`);
  console.log(`  fileExtensions:  ${Object.keys(manifest.fileExtensions).length}`);
  console.log(`  folderNames:     ${Object.keys(manifest.folderNames).length}`);

  writeFileSync(OUT, JSON.stringify(manifest));
  console.log(`\nWritten to: ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)}KB)`);

  return manifest;
}

buildManifest();

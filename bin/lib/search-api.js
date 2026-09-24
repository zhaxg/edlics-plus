// search-api.js — filename search (walk) and full-text content search.
// search-content uses async fs so a big workspace never blocks the event loop.
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const { getRootDir, getExcludes, toPosix } = require('./paths');

/**
 * @typedef {Object} ContentMatch
 * @property {string} path   absolute file path
 * @property {number} line   1-based line number
 * @property {number} column 1-based column of the first char of the match
 * @property {string} text   the source line (truncated to 300 chars)
 */

const MAX_RESULTS = 500;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // skip files > 2MB

function handleFilenameSearch(ctx) {
  const { params, ok, fail, checkPath } = ctx;
  const searchPath = params.path || (getRootDir() || '/');
  if (!checkPath(searchPath)) return;
  const results = [];
  function walk(dir, cb) {
    const excluded = getExcludes(dir);
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return cb();
      let pending = entries.length;
      if (pending === 0) return cb();
      for (const e of entries) {
        if (e.name.startsWith('.') || excluded.has(e.name)) { if (--pending === 0) cb(); continue; }
        const full = path.join(dir, e.name);
        if (full.length > 4096) { if (--pending === 0) cb(); continue; }
        if (results.length >= 200) { if (--pending === 0) cb(); continue; }
        if (e.name.toLowerCase().includes((params.q || '').toLowerCase())) results.push(toPosix(full));
        if (e.isDirectory()) {
          walk(full, () => { if (--pending === 0) cb(); });
        } else {
          if (--pending === 0) cb();
        }
      }
    });
  }
  walk(searchPath, () => ok(results));
}

/**
 * Pure matcher: collect matches of `needle` inside `content`.
 * Exported for unit tests (no filesystem involved).
 * @param {string} filePath reported as the match path
 * @param {string} content
 * @param {string} needle already lowercased when caseSensitive=false
 * @param {boolean} caseSensitive
 * @param {number} cap max matches to return
 * @returns {ContentMatch[]}
 */
function collectMatches(filePath, content, needle, caseSensitive, cap) {
  const out = [];
  if (!needle) return out;
  const hay = caseSensitive ? content : content.toLowerCase();
  if (!hay.includes(needle)) return out;
  const lines = content.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li];
    const hayLine = caseSensitive ? lineText : lineText.toLowerCase();
    let from = 0;
    let col;
    while ((col = hayLine.indexOf(needle, from)) !== -1) {
      out.push({ path: filePath, line: li + 1, column: col + 1, text: lineText.slice(0, 300) });
      if (out.length >= cap) return out;
      from = col + needle.length;
      if (needle.length === 0) break;
    }
  }
  return out;
}

async function searchOneFile(filePath, needle, caseSensitive) {
  let buf;
  try { buf = await fsp.readFile(filePath); } catch { return []; }
  if (buf.length > MAX_FILE_SIZE) return [];
  // Skip binary (null byte in first 8KB)
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i++) if (buf[i] === 0) return [];
  // report the path in POSIX form (read uses the native path as-is)
  return collectMatches(toPosix(filePath), buf.toString('utf-8'), needle, caseSensitive, MAX_RESULTS);
}

async function walkContent(dir, state) {
  if (state.done) return;
  const excluded = getExcludes(dir);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (state.done) return;
    if (ent.name.startsWith('.') || excluded.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (full.length > 4096) continue;
    if (ent.isDirectory()) {
      await walkContent(full, state);
      continue;
    }
    const found = await searchOneFile(full, state.needle, state.caseSensitive);
    for (const m of found) {
      state.results.push(m);
      if (state.results.length >= MAX_RESULTS) { state.done = true; return; }
    }
  }
}

async function handleSearchContent(ctx) {
  const { params, ok, fail, checkPath } = ctx;
  const searchPath = params.path || (getRootDir() || '/');
  if (!checkPath(searchPath)) return;
  const q = params.q || '';
  if (!q) return ok([]);
  const caseSensitive = params.case === '1';
  const needle = caseSensitive ? q : q.toLowerCase();
  try {
    const stat = await fsp.stat(searchPath);
    if (stat.isFile()) {
      return ok(await searchOneFile(searchPath, needle, caseSensitive));
    }
    const state = { results: [], needle, caseSensitive, done: false };
    await walkContent(searchPath, state);
    ok(state.results);
  } catch (e) {
    fail(e.message);
  }
}

/** Route table — see CLAUDE.md. */
const routes = [
  { name: 'api/search',         match: p => p[1] === 'search',         handle: handleFilenameSearch },
  { name: 'api/search-content', match: p => p[1] === 'search-content', handle: ctx => handleSearchContent(ctx) },
];

module.exports = { routes, collectMatches, MAX_RESULTS, MAX_FILE_SIZE };

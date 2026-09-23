// search.mjs — Toolbar filename search (Ctrl+P) + sidebar full-text search panel

import { api, toast, escapeHtml } from './api.mjs';
import { currentDir, HOME, setCurrentDir, state } from './state.mjs';
import { openFile } from './file-ops.mjs';
import { renderTree, getRootPath } from './file-tree.mjs';

let searchTimeout;

// ---------- Toolbar: quick filename search (legacy behavior) ----------
export function initSearch() {
  const box = document.getElementById('searchBox');
  const boxClear = document.getElementById('searchBoxClear');
  const syncBoxClear = () => boxClear.classList.toggle('hidden', !box.value);

  box.addEventListener('input', () => {
    syncBoxClear();
    clearTimeout(searchTimeout);
    const q = box.value.trim();
    if (!q) { renderTree(); return; }
    searchTimeout = setTimeout(() => {
      const scope = document.getElementById('searchScope').textContent === 'All' ? (HOME || '/') : currentDir;
      api('GET', `/api/search?path=${encodeURIComponent(scope)}&q=${encodeURIComponent(q)}`).then(results => {
        if (!Array.isArray(results) || results.length === 0) { toast('No results', true); return; }
        const tree = document.getElementById('fileTree');
        const scopeLabel = document.getElementById('searchScope').textContent === 'All' ? 'Global' : 'Current dir';
        tree.innerHTML = '<div class="tree-item" style="color:var(--text-dim);padding:8px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">' + scopeLabel + ' search: ' + escapeHtml(q) + '</div>';
        for (const r of results.slice(0, 200)) {
          const div = document.createElement('div');
          div.className = 'tree-item';
          div.textContent = r;
          div.style.fontSize = '12px';
          div.onclick = () => { openFile(r); box.value = ''; syncBoxClear(); renderTree(); };
          tree.appendChild(div);
        }
      });
    }, 300);
  });

  boxClear.addEventListener('click', () => {
    box.value = '';
    syncBoxClear();
    clearTimeout(searchTimeout);
    renderTree();
    box.focus();
  });
  syncBoxClear();

  initContentSearch();
}

// ---------- Sidebar: full-text content search (VS Code Ctrl+Shift+F style) ----------
function initContentSearch() {
  const input = document.getElementById('searchContentInput');
  const clearBtn = document.getElementById('searchContentClear');
  const results = document.getElementById('searchResults');
  const caseBtn = document.getElementById('searchCaseBtn');
  const regexBtn = document.getElementById('searchRegexBtn');
  if (!input) return;

  let caseSensitive = false;
  let useRegex = false;
  let seq = 0; // stale-response guard
  const syncClear = () => clearBtn.classList.toggle('hidden', !input.value);

  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    caseBtn.classList.toggle('on', caseSensitive);
    if (input.value) runSearch();
  });
  regexBtn.addEventListener('click', () => {
    useRegex = !useRegex;
    regexBtn.classList.toggle('on', useRegex);
    if (input.value) runSearch();
  });

  let timer;
  input.addEventListener('input', () => { syncClear(); clearTimeout(timer); timer = setTimeout(runSearch, 350); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    syncClear();
    clearTimeout(timer);
    seq++; // invalidate any in-flight search
    results.innerHTML = '';
    input.focus();
  });
  syncClear();

  function runSearch() {
    const q = input.value.trim();
    const mySeq = ++seq;
    if (!q) { results.innerHTML = ''; return; }
    const root = getRootPath() || state.workspace || HOME;
    const flags = caseSensitive ? '1' : '0';
    api('GET', `/api/search-content?path=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&case=${flags}`)
      .then(items => {
        if (mySeq !== seq) return; // superseded by a newer search
        renderResults(q, items);
      })
      .catch(() => {});
  }

  function highlight(text, q) {
    // Escape HTML first, then wrap matches
    const esc = escapeHtml(text);
    if (useRegex) {
      try {
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
        return esc.replace(re, m => `<mark>${m}</mark>`);
      } catch { return esc; }
    }
    const needle = caseSensitive ? q : q.toLowerCase();
    const hay = caseSensitive ? esc : esc.toLowerCase();
    let out = ''; let i = 0;
    while (true) {
      const idx = hay.indexOf(needle, i);
      if (idx === -1 || !needle) { out += esc.slice(i); break; }
      out += esc.slice(i, idx) + '<mark>' + esc.slice(idx, idx + needle.length) + '</mark>';
      i = idx + needle.length;
    }
    return out;
  }

  function renderResults(q, items) {
    if (!Array.isArray(items) || items.length === 0) {
      results.innerHTML = `<div class="search-empty">${q ? 'No results found' : ''}</div>`;
      return;
    }
    // Group by file path
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.path)) groups.set(it.path, []);
      groups.get(it.path).push(it);
    }
    results.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'search-summary';
    summary.textContent = `${items.length} result${items.length === 1 ? '' : 's'} in ${groups.size} file${groups.size === 1 ? '' : 's'}`;
    results.appendChild(summary);

    for (const [path, matches] of groups) {
      const fileDiv = document.createElement('div');
      fileDiv.className = 'search-file';
      const name = path.split(/[\\/]/).pop();
      fileDiv.innerHTML = `<div class="search-file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</div>`;
      for (const m of matches) {
        const row = document.createElement('div');
        row.className = 'search-match';
        row.innerHTML = `<span class="search-line-no">${m.line}</span><span class="search-line-text">${highlight(m.text.trim(), q)}</span>`;
        row.title = path + ':' + m.line + ':' + m.column;
        row.addEventListener('click', () => openFile(path, false, { line: m.line, column: m.column }));
        fileDiv.appendChild(row);
      }
      results.appendChild(fileDiv);
    }
  }
}

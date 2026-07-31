// search.mjs — File search

import { api, toast } from './api.mjs';
import { currentDir, HOME, setCurrentDir } from './state.mjs';
import { openFile } from './file-ops.mjs';
import { renderTree } from './file-tree.mjs';

let searchTimeout;

export function initSearch() {
  document.getElementById('searchBox').addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) { renderTree(currentDir); return; }
    searchTimeout = setTimeout(() => {
      const scope = document.getElementById('searchScope').textContent === 'All' ? (HOME || '/') : currentDir;
      api('GET', `/api/search?path=${encodeURIComponent(scope)}&q=${encodeURIComponent(q)}`).then(results => {
        if (!Array.isArray(results) || results.length === 0) { toast('No results', true); return; }
        const tree = document.getElementById('fileTree');
        const scopeLabel = document.getElementById('searchScope').textContent === 'All' ? 'Global' : 'Current dir';
        tree.innerHTML = '<div class="tree-item" style="color:var(--text-dim);padding:8px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">' + scopeLabel + ' search: ' + q + '</div>';
        for (const r of results.slice(0, 200)) {
          const div = document.createElement('div');
          div.className = 'tree-item';
          div.textContent = r;
          div.style.fontSize = '12px';
          div.onclick = () => { openFile(r); document.getElementById('searchBox').value = ''; renderTree(currentDir); };
          tree.appendChild(div);
        }
      });
    }, 300);
  });
}

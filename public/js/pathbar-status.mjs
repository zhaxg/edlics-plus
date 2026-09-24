// pathbar-status.mjs — breadcrumb path bar + status bar (line counts).
import { state } from './state.mjs';
import { basename } from './api.mjs';

export function updatePathBar(filePath) {
  const el = document.getElementById('pathBar');
  el.innerHTML = '';
  const parts = filePath.split('/').filter(Boolean);
  // POSIX paths split cleanly; Windows drive paths arrive as 'E:/…' so the
  // first segment ('E:') must not get a leading slash prepended.
  const hasDrive = /^[A-Za-z]:$/.test(parts[0] || '');
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; el.appendChild(s); }
    if (i === 0) current = hasDrive ? parts[0] : '/' + parts[0];
    else current += '/' + parts[i];
    const span = document.createElement('span');
    span.textContent = parts[i];
    if (parts[i] !== basename(filePath)) {
      span.style.cursor = 'pointer';
      const dir = current;
      span.addEventListener('click', function () { import('./file-tree.mjs').then(m => m.revealPath(dir)); });
    }
    el.appendChild(span);
  }
}

export function updateStatus() {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (!tab) { document.getElementById('statusLeft').textContent = ''; document.getElementById('statusRight').textContent = ''; return; }
  const lines = tab.content.split('\n').length;
  document.getElementById('statusLeft').textContent = tab.path;
  document.getElementById('statusRight').textContent = `${lines} lines${state.dirty.has(tab.path) ? ' ● modified' : ''}`;
}

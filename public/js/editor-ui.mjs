// editor-ui.mjs — CodeMirror editor, tabs, path bar

import { EditorView, EditorState, keymap, basicSetup, javascript, python, html, css, json, markdown, xml, yaml } from '/editor.mjs';
import { state, serverInfo } from './state.mjs';
import { escapeHtml, basename, confirmDialog } from './api.mjs';
import { themeCompartment, currentTheme } from './theme.mjs';

// Tab context menu (avoid circular dep with context-menu.mjs)
const _tabCtxIcons = {
  delete: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  copy:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
};
export function showTabContextMenu(x, y, tab) {
  const menu = document.getElementById('contextMenu');
  const items = [
    { icon: 'delete', label: 'Close', action: () => removeTab(tab.id) },
    { icon: 'delete', label: 'Close Others', action: async () => {
      const others = state.tabs.filter(t => t.id !== tab.id);
      for (const t of others) { if (state.dirty.has(t.path) && !await confirmDialog(`"${t.name}" has unsaved changes. Close anyway?`)) return; }
      state.tabs = [tab]; state.dirty.forEach(p => { if (p !== tab.path) state.dirty.delete(p); });
      state.activeTab = tab.id; renderTabs(); loadEditor(tab);
    }},
    { icon: 'delete', label: 'Close All', action: async () => {
      for (const t of state.tabs) { if (state.dirty.has(t.path) && !await confirmDialog(`"${t.name}" has unsaved changes. Close anyway?`)) return; }
      state.tabs = []; state.dirty.clear(); state.activeTab = null; renderTabs(); closeEditor();
    }},
    { icon: 'copy', label: 'Copy Path', action: () => { import('./api.mjs').then(m => { m.copyToClipboard(tab.path); m.toast('Copied'); }); } },
  ];
  menu.innerHTML = items.map(item =>
    `<div class="context-menu-item"><span class="ctx-icon">${_tabCtxIcons[item.icon]}</span>${item.label}</div>`
  ).join('');
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 10) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 10) + 'px';
  menu.onclick = (e) => {
    const idx = Array.from(menu.children).indexOf(e.target.closest('.context-menu-item'));
    if (idx >= 0) items[idx].action();
    menu.classList.add('hidden');
  };
}

const CM6_LANG = {
  '.js': () => javascript(), '.jsx': () => javascript({ jsx: true }),
  '.ts': () => javascript({ typescript: true }), '.tsx': () => javascript({ jsx: true, typescript: true }),
  '.py': () => python(),
  '.html': () => html(), '.htm': () => html(),
  '.css': () => css(), '.scss': () => css(), '.less': () => css(),
  '.json': () => json(),
  '.xml': () => xml(), '.svg': () => xml(),
  '.md': () => markdown(),
  '.yml': () => yaml(), '.yaml': () => yaml(),
};

function getCM6Lang(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const fn = CM6_LANG[ext];
  if (!fn) return [];
  try { const r = fn(); return Array.isArray(r) ? r : [r]; } catch { return []; }
}

export function addTab(filePath, content, switchTo = true) {
  const existing = state.tabs.find(t => t.path === filePath);
  if (existing) { if (switchTo) setActiveTab(existing.id); return existing; }
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const tab = { id, path: filePath, name: basename(filePath), content: content || '', savedContent: content || '' };
  state.tabs.push(tab);
  renderTabs();
  if (switchTo) setActiveTab(id);
  return tab;
}

export async function removeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (state.dirty.has(tab.path)) {
    if (!await confirmDialog(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
  }
  if (tab.cmView) { tab.cmView.view.destroy(); tab.cmView = null; }
  state.tabs.splice(idx, 1);
  state.dirty.delete(tab.path);
  if (state.activeTab === id) {
    if (state.tabs.length > 0) setActiveTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
    else { state.activeTab = null; closeEditor(); }
  }
  if (state.tabs.length === 0) closeEditor();
  renderTabs();
}

export function setActiveTab(id) {
  state.activeTab = id;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  renderTabs();
  loadEditor(tab);
}

export function renderTabs() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  for (const tab of state.tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.id === state.activeTab ? ' active' : '');
    div.textContent = (state.dirty.has(tab.path) ? '● ' : '') + tab.name;
    const close = document.createElement('span');
    close.className = 'close'; close.textContent = '×';
    close.addEventListener('click', function (e) { e.stopPropagation(); removeTab(tab.id); });
    div.appendChild(close);
    div.addEventListener('click', function () { setActiveTab(tab.id); });
    div.addEventListener('contextmenu', function (e) { e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, tab); });
    container.appendChild(div);
  }
}

export function closeEditor() {
  if (state.editorView) { state.editorView.destroy(); state.editorView = null; }
  const area = document.getElementById('editorArea');
  area.querySelectorAll('textarea').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.classList.remove('hidden');
  document.getElementById('pathBar').innerHTML = '';
  if (serverInfo) {
    document.getElementById('statusLeft').textContent = serverInfo.user + '@' + serverInfo.hostname;
    document.getElementById('statusRight').textContent = serverInfo.ip;
  } else {
    document.getElementById('statusLeft').textContent = '';
    document.getElementById('statusRight').textContent = '';
  }
}

export function loadEditor(tab) {
  const welcome = document.getElementById('welcome');
  const area = document.getElementById('editorArea');
  if (!welcome || !area) return;
  welcome.classList.add('hidden');
  if (!tab) return;
  if (state.editorView) { state.editorView.destroy(); state.editorView = null; }
  area.querySelectorAll('textarea').forEach(el => el.remove());
  try {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        tab.content = update.state.doc.toString();
        if (tab.content !== tab.savedContent) state.dirty.add(tab.path);
        else state.dirty.delete(tab.path);
        renderTabs();
        updateStatus();
      }
    });
    const cm6Keymap = keymap.of([{ key: 'Mod-s', run: () => { import('./file-ops.mjs').then(m => m.saveFile()); return true; } }]);
    const cm6Theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { overflow: 'auto' },
      '.cm-content': { fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace', tabSize: '2' },
    });
    const langExt = getCM6Lang(tab.path);
    const startState = EditorState.create({
      doc: tab.content || '',
      extensions: [basicSetup, updateListener, cm6Keymap, cm6Theme, themeCompartment.of(currentTheme), ...langExt],
    });
    state.editorView = new EditorView({ state: startState, parent: area });
    tab.cmView = { view: state.editorView };
    state.editorView.focus();
    updatePathBar(tab.path);
    updateStatus();
  } catch (e) {
    area.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--red);font-size:13px;padding:20px;">⚠ ' + escapeHtml(e.message) + '</div>';
  }
}

export function updatePathBar(filePath) {
  const el = document.getElementById('pathBar');
  el.innerHTML = '';
  const parts = filePath.split('/').filter(Boolean);
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; el.appendChild(s); }
    current += '/' + parts[i];
    const span = document.createElement('span');
    span.textContent = parts[i];
    if (parts[i] !== basename(filePath)) {
      span.style.cursor = 'pointer';
      const dir = current;
      span.addEventListener('click', function () { import('./file-tree.mjs').then(m => m.renderTree(dir)); });
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

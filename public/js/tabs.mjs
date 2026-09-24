// tabs.mjs — tab state, tab bar rendering, tab context menu.
// loadEditor/closeEditor come from editor-ui.mjs (runtime-only cycle, see CLAUDE.md).
import { state } from './state.mjs';
import { basename, confirmDialog } from './api.mjs';
import { isPreviewableFile } from './markdown-preview.mjs';
import { loadEditor, closeEditor } from './editor-ui.mjs';

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
    { icon: 'copy', label: 'Copy Path', action: () => { import('./api.mjs').then(m => { m.copyToClipboard(m.workspaceRelative(tab.path)); m.toast('Copied'); }); } },
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

// Tab bar: wheel scroll + hover scrollbar
const _tabsEl = document.getElementById('tabs');
if (_tabsEl) {
  _tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      _tabsEl.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  _tabsEl.addEventListener('mouseenter', () => _tabsEl.classList.add('show-scrollbar'));
  _tabsEl.addEventListener('mouseleave', () => _tabsEl.classList.remove('show-scrollbar'));
}

export function addTab(filePath, content, switchTo = true, type = 'text', size = 0, fileType = null) {
  const existing = state.tabs.find(t => t.path === filePath);
  if (existing) { if (switchTo) setActiveTab(existing.id); return existing; }
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const tab = { id, path: filePath, name: basename(filePath), content: content || '', savedContent: content || '', type, size, fileType };
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
  // Clean up md preview references
  if (tab._previewPanel) { tab._previewPanel.remove(); tab._previewPanel = null; }
  if (tab._cmWrapper) { tab._cmWrapper.remove(); tab._cmWrapper = null; }
  tab._updatePreview = null;
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
  loadEditor(tab);
  renderTabs();
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

  // Add markdown/SVG preview toggle button at the right end (VS Code style)
  const toggleContainer = document.getElementById('tabsToggle');
  toggleContainer.innerHTML = '';
  const activeTab = state.tabs.find(t => t.id === state.activeTab);
  if (activeTab && isPreviewableFile(activeTab.path)) {
    const mdToggle = document.createElement('div');
    mdToggle.className = 'md-tab-toggle';
    mdToggle.title = 'Toggle preview';
    const isPreview = activeTab._previewMode === 'preview';
    mdToggle.innerHTML = isPreview
      ? '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M6.5 2a.5.5 0 0 0 0 1h1v10h-1a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-1V3h1a.5.5 0 0 0 0-1zM4 4h2.5v1H4a1 1 0 0 0-1 1v3.997a1 1 0 0 0 1 1h2.5v1H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m8 6.997H9.5v1H12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H9.5v1H12a1 1 0 0 1 1 1v3.997a1 1 0 0 1-1 1"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M13.5 1h-9A2.503 2.503 0 0 0 2 3.5v2.776a4.4 4.4 0 0 1 1-.226V3.499c0-.827.673-1.5 1.5-1.5h4v11.386l1.057 1.057c.157.149.274.344.35.557H13.5c1.378 0 2.5-1.122 2.5-2.5V3.5C16 2.122 14.878 1 13.5 1M15 12.5c0 .827-.673 1.5-1.5 1.5h-4V2h4c.827 0 1.5.673 1.5 1.5zm-8.71.09c.45-.58.71-1.31.71-2.09C7 8.57 5.43 7 3.5 7S0 8.57 0 10.5S1.57 14 3.5 14c.78 0 1.51-.26 2.09-.71l2.56 2.56c.09.1.22.15.35.15s.26-.05.35-.15c.2-.19.2-.51 0-.7zM5.5 12a2.5 2.5 0 0 1-2 1a2.5 2.5 0 0 1 0-5a2.5 2.5 0 0 1 2 4"/></svg>';
    mdToggle.addEventListener('click', () => import('./editor-ui.mjs').then(m => m.toggleMdPreview(activeTab)));
    toggleContainer.appendChild(mdToggle);
  }

  // Refresh button — re-read file from disk (all file types except diffs)
  if (activeTab && activeTab.type !== 'diff') {
    const refreshBtn = document.createElement('div');
    refreshBtn.className = 'md-tab-toggle';
    refreshBtn.title = 'Reload file';
    refreshBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path stroke-miterlimit="10" d="M18.024 7.043A8.374 8.374 0 0 0 3.74 12.955"/><path stroke-linejoin="round" d="m17.35 2.75l.832 3.372a1.123 1.123 0 0 1-.854 1.382l-3.372.843"/><path stroke-miterlimit="10" d="M5.976 16.957a8.374 8.374 0 0 0 14.285-5.912"/><path stroke-linejoin="round" d="m6.65 21.25l-.832-3.372a1.124 1.124 0 0 1 .855-1.382l3.371-.843"/></g></svg>';
    refreshBtn.addEventListener('click', () => {
      const url = '/api/read?path=' + encodeURIComponent(activeTab.path);
      import('./api.mjs').then(m => {
        m.api('GET', url).then(data => {
          if (data.error) { m.toast(data.error, true); return; }
          activeTab.content = data.content;
          activeTab.savedContent = data.content;
          state.dirty.delete(activeTab.path);
          import('./editor-ui.mjs').then(e => e.loadEditor(activeTab));
          renderTabs();
          m.toast('Reloaded');
        });
      });
    });
    toggleContainer.appendChild(refreshBtn);
  }

  // Scroll active tab into view
  const activeEl = container.querySelector('.tab.active');
  if (activeEl) {
    activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

// app.mjs — Main entry point

import { state, HOME, currentDir, setHOME, setServerInfo, setSudoPassword, setIconManifest, setRootRestricted } from './state.mjs';
import { api } from './api.mjs';
import { initTheme } from './theme.mjs';
import { renderTree, initFileTree } from './file-tree.mjs';
import { openFile, saveFile, deleteItem, renameItem } from './file-ops.mjs';
import { removeTab, setActiveTab } from './editor-ui.mjs';
import { initContextMenu } from './context-menu.mjs';
import { initSearch } from './search.mjs';
import { initSidebarResize } from './sidebar.mjs';

// Init
document.getElementById('btnRefresh').onclick = () => renderTree(currentDir);
document.querySelector('.logo').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('collapsed');
  document.querySelector('.sidebar-resize').classList.toggle('collapsed');
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); document.getElementById('searchBox').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (state.activeTab) removeTab(state.activeTab); }
  if (e.key === 'F2' && state.activeTab) { e.preventDefault(); const tab = state.tabs.find(t => t.id === state.activeTab); if (tab) renameItem(tab.path); }
  if (e.key === 'Escape') { document.getElementById('dialogOverlay').classList.add('hidden'); document.getElementById('contextMenu').classList.add('hidden'); }
});

// Load icon manifest
fetch('/icon-manifest.json').then(r => r.json()).then(m => { setIconManifest(m); }).catch(() => {});

// Init modules
initTheme();
initContextMenu();
initFileTree();
initSearch();
initSidebarResize();

// Load server info and render
api('GET', '/api/info').then(data => {
  if (data && data.user) {
    setServerInfo(data);
    if (data.home) setHOME(data.home);
    if (data.root) setRootRestricted(true);
    document.getElementById('serverBadge').textContent = data.user + '@' + data.hostname;
    document.getElementById('statusLeft').innerHTML = 'Edlics-plus <a href="https://www.npmjs.com/package/edlics-plus" target="_blank" style="color:inherit;text-decoration:none;">v' + data.version + '</a>';
    document.getElementById('statusRight').textContent = data.ip;
    if (data.readonly) {
      document.getElementById('sudoBadge').style.display = 'inline';
      document.getElementById('sudoBadge').textContent = 'readonly';
      document.getElementById('sudoBadge').style.color = 'var(--accent)';
      document.getElementById('welcomeText').textContent = 'Select a file to view';
    } else {
      document.getElementById('welcomeText').textContent = 'Select a file to edit';
    }
  }
  renderTree(HOME);
}).catch(() => { renderTree(HOME); });

api('GET', '/api/sudo-status').then(status => {
  if (status.nopasswd) {
    setSudoPassword(true);
    document.getElementById('sudoBadge').style.display = 'inline';
    document.getElementById('sudoBadge').textContent = 'sudo';
  }
}).catch(() => {});

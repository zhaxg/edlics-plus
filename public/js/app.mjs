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
    const dockerIcon = data.docker ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" style="vertical-align:-2px;margin-right:2px;"><path fill="#999" d="M12.988 11.321h-2.035V9.448h2.035zm0-6.363h-2.035v1.906h2.035zm2.455 4.554h-2.035v1.842h2.035zM10.566 7.22H8.53v1.873h2.034zm2.422 0h-2.035v1.873h2.035zm8.689 3.133c-.452-.323-1.486-.42-2.261-.258c-.097-.775-.55-1.421-1.26-2.003l-.452-.258l-.258.452c-.55.872-.743 2.326-.13 3.262a3.4 3.4 0 0 1-1.485.356H2.07c-.259 1.582.193 3.682 1.356 5.103c1.13 1.357 2.907 2.035 5.168 2.035c4.91 0 8.592-2.26 10.272-6.395c.646 0 2.132 0 2.875-1.422c.032-.032.226-.42.258-.549zm-15.989-.84H3.621v1.842h2.035V9.512zm2.423 0H6.076v1.842H8.11zm2.454 0H8.532v1.842h2.034zM8.111 7.22H6.076v1.873H8.11z"/></svg>' : '';
    document.getElementById('serverBadge').innerHTML = dockerIcon + data.user + '@' + data.hostname;
    document.getElementById('statusLeft').innerHTML = dockerIcon + data.user + '@' + data.hostname;
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

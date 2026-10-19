// app.mjs — Main entry point
//
// The UI is split in two layers:
//   * shell.mjs / views/*    — Preact: the activity rail + all console pages
//   * everything else        — plain-DOM modules for the IDE (CodeMirror, xterm)
// The IDE modules mount into the static markup in index.html; the console pages
// are rendered by Preact into #consoleArea and the rail into #railHost.

import { state, setHOME, setServerInfo, setSudoPassword, setIconManifest, setRootRestricted } from './state.mjs';
import { api } from './api.mjs';
import { initAuth, logout } from './auth.mjs';
import { initTheme } from './theme.mjs';
import { renderTree, initFileTree } from './file-tree.mjs';
import { initWorkspace, openFolderDialog } from './workspace.mjs';
import { saveFile, deleteItem, renameItem } from './file-ops.mjs';
import { removeTab } from './editor-ui.mjs';
import { initContextMenu } from './context-menu.mjs';
import { initSearch } from './search.mjs';
import { initSidebarResize } from './sidebar.mjs';
import { mountShell, switchView, applyInitialView } from './shell.mjs';
import { get as getStore, set as setStore } from './store.mjs';
import { initGit } from './git.mjs';
import { initTerminal } from './terminal-ui.mjs';

// Shell first: the rail and the console host are Preact-rendered.
mountShell(document.getElementById('railHost'), document.getElementById('consoleArea'));

// Init
document.getElementById('btnRefresh').onclick = () => renderTree();
document.getElementById('btnOpenFolder').onclick = () => openFolderDialog();
const logoutBtn = document.getElementById('btnLogout');
if (logoutBtn) logoutBtn.addEventListener('click', logout);
document.querySelector('.logo').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('collapsed');
  document.querySelector('.sidebar-resize').classList.toggle('collapsed');
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  // While typing in the terminal (or login/search inputs), don't hijack keys
  const ae = document.activeElement;
  const inTerminal = state.terminalOpen && ae && ae.closest && ae.closest('.terminal-container');
  if (inTerminal) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p' && !e.shiftKey) { e.preventDefault(); document.getElementById('searchBox').focus(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault();
    switchView('search');
    const input = document.getElementById('searchContentInput');
    if (input) { input.focus(); input.select(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); switchView('explorer'); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); switchView('git'); }
  if ((e.ctrlKey || e.metaKey) && e.key === '`') {
    e.preventDefault();
    switchView(getStore().view === 'terminal' ? 'explorer' : 'terminal');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (state.activeTab) removeTab(state.activeTab); }
  if (e.key === 'F2' && state.activeTab) { e.preventDefault(); const tab = state.tabs.find(t => t.id === state.activeTab); if (tab) renameItem(tab.path); }
  if (e.key === 'Escape') { document.getElementById('dialogOverlay').classList.add('hidden'); document.getElementById('contextMenu').classList.add('hidden'); }
});

// Load icon manifest
fetch('/icon-manifest.json').then(r => r.json()).then(m => { setIconManifest(m); }).catch(() => {});

// Init modules (IDE side — the console pages initialise themselves on mount)
initTheme();
initContextMenu();
initFileTree();
initSearch();
initSidebarResize();
initGit();
initTerminal();

// Load server info and render — only after login succeeds
function bootApp() {
  api('GET', '/api/info').then(data => {
    if (data && data.user) {
      setServerInfo(data);
      setStore({ serverInfo: data });
      if (data.home) setHOME(data.home);
      if (data.root) setRootRestricted(true);
      document.getElementById('serverBadge').textContent = data.user + '@' + data.hostname;
      document.getElementById('appVersion').textContent = 'v' + data.version;
      document.getElementById('statusRight').textContent = data.ip;
      // Let the rail re-render now that admin gating is known.
      document.dispatchEvent(new CustomEvent('server-info', { detail: data }));
      if (data.readonly) {
        document.getElementById('sudoBadge').style.display = 'inline';
        document.getElementById('sudoBadge').textContent = 'readonly';
        document.getElementById('sudoBadge').style.color = 'var(--accent)';
        document.getElementById('welcomeText').textContent = 'Select a file to view';
      } else {
        document.getElementById('welcomeText').textContent = 'Select a file to edit';
      }
    }
    setStore({ authed: true });
    initWorkspace();
    applyInitialView();
  }).catch(() => {
    setStore({ authed: true });
    initWorkspace();
    applyInitialView();
  });

  api('GET', '/api/sudo-status').then(status => {
    if (status.nopasswd) {
      setSudoPassword(true);
      document.getElementById('sudoBadge').style.display = 'inline';
      document.getElementById('sudoBadge').textContent = 'sudo';
    }
  }).catch(() => {});
}

// Gate: show login overlay unless a valid session cookie already exists
initAuth(bootApp);

// activity.mjs — Left activity bar: switch sidebar views, toggle terminal panel

import { state } from './state.mjs';

const VIEW_TO_PANEL = {
  explorer: 'panel-explorer',
  search: 'panel-search',
  git: 'panel-git',
};

export function switchView(view) {
  if (!VIEW_TO_PANEL[view]) return;
  state.currentView = view;
  for (const [v, panelId] of Object.entries(VIEW_TO_PANEL)) {
    document.getElementById(panelId).classList.toggle('hidden', v !== view);
  }
  document.querySelectorAll('.act-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view && view !== 'terminal');
  });
  // Reveal sidebar if it was collapsed
  document.querySelector('.sidebar').classList.remove('collapsed');
  document.querySelector('.sidebar-resize').classList.remove('collapsed');
}

export function toggleTerminal(force) {
  const panel = document.getElementById('terminalPanel');
  const btn = document.querySelector('.act-btn[data-view="terminal"]');
  const show = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  btn.classList.toggle('active', show);
  state.terminalOpen = show;
  if (show && state.onTerminalShow) state.onTerminalShow();
}

export function initActivityBar() {
  document.querySelectorAll('.act-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'terminal') {
        toggleTerminal();
        return;
      }
      // Clicking the active view collapses the sidebar (VS Code behavior)
      if (state.currentView === view && !document.querySelector('.sidebar').classList.contains('collapsed')) {
        document.querySelector('.sidebar').classList.add('collapsed');
        document.querySelector('.sidebar-resize').classList.add('collapsed');
      } else {
        switchView(view);
      }
    });
  });

  document.getElementById('terminalClose').addEventListener('click', () => toggleTerminal(false));
  // terminalKill is wired by terminal.mjs once the shell exists
}

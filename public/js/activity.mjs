// activity.mjs — Left activity rail: switch views.
//
// Two families of view:
//   * IDE views  (explorer/search/git)      → sidebar panel + editor area
//   * Console views (dashboard/services/…)  → a single full-width page
// Console pages live in #consoleArea (no left/right split); only IDE views use
// the sidebar. Navigation is reflected in the URL hash so pages are linkable.

import { state, serverInfo } from './state.mjs';
import { toast } from './api.mjs';

// IDE views keep the sidebar (list + editor is a natural split).
const IDE_VIEWS = {
  explorer: 'panel-explorer',
  search: 'panel-search',
  git: 'panel-git',
};

// Console views render full-width, one page at a time.
const CONSOLE_VIEWS = {
  overview: { page: 'page-overview', title: 'Dashboard' },
  services: { page: 'page-services', title: 'System' },
  containers: { page: 'page-containers', title: 'Containers' },
  terminal: { page: 'page-terminal', title: 'Terminal' },
};

// Older deep links still resolve (network/access/users/cron merged into
// services; the process table lives under the Dashboard).
const VIEW_ALIAS = {
  users: 'services', cron: 'services', network: 'services', access: 'services', processes: 'overview',
};

function el(id) { return document.getElementById(id); }

/** Is `view` a console (full-width page) view? */
export function isConsoleView(view) { return !!CONSOLE_VIEWS[view]; }

export function switchView(view, opts = {}) {
  view = VIEW_ALIAS[view] || view;
  const consoleDef = CONSOLE_VIEWS[view];
  const idePanel = IDE_VIEWS[view];
  if (!consoleDef && !idePanel) return;
  // The terminal page needs the server's --terminal flag.
  if (view === 'terminal' && serverInfo && serverInfo.terminal === false) {
    toast('Terminal is disabled — start the server with --terminal to enable it', true);
    return;
  }
  state.currentView = view;

  const consoleArea = el('consoleArea');
  const pageTitle = el('pageTitle');

  if (consoleDef) {
    document.body.classList.add('console-mode');
    if (consoleArea) consoleArea.classList.remove('hidden');
    // hide all pages, then reveal the target one
    for (const def of Object.values(CONSOLE_VIEWS)) {
      const p = el(def.page);
      if (p) p.classList.toggle('hidden', def.page !== consoleDef.page);
    }
    if (pageTitle) pageTitle.textContent = consoleDef.title;
  } else {
    document.body.classList.remove('console-mode');
    if (consoleArea) consoleArea.classList.add('hidden');
    for (const [v, panelId] of Object.entries(IDE_VIEWS)) {
      const p = el(panelId);
      if (p) p.classList.toggle('hidden', v !== view);
    }
    // Reveal sidebar if it was collapsed
    const sb = document.querySelector('.sidebar');
    const rz = document.querySelector('.sidebar-resize');
    if (sb) sb.classList.remove('collapsed');
    if (rz) rz.classList.remove('collapsed');
  }

  document.querySelectorAll('button.act-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  if (!opts.fromHash) {
    const want = '#/' + view;
    if (location.hash !== want) {
      try { history.replaceState(null, '', want); } catch { location.hash = want; }
    }
  }
  // Terminal page owns the PTY lifecycle via state.onTerminalShow.
  state.terminalOpen = view === 'terminal';
  if (view === 'terminal' && state.onTerminalShow) state.onTerminalShow();
  document.dispatchEvent(new CustomEvent('view-changed', { detail: { view } }));
}

function viewFromHash() {
  const m = /^#\/?([a-z]+)/.exec(location.hash || '');
  const raw = m && m[1];
  const v = VIEW_ALIAS[raw] || raw;
  return v && (CONSOLE_VIEWS[v] || IDE_VIEWS[v]) ? v : null;
}

export function initActivityBar() {
  // buttons only — .act-btn-bottom is an <a> (GitHub link), not a view switcher
  document.querySelectorAll('button.act-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      // Clicking the active IDE view collapses the sidebar (VS Code behavior)
      if (IDE_VIEWS[view] && state.currentView === view &&
          !document.querySelector('.sidebar').classList.contains('collapsed')) {
        document.querySelector('.sidebar').classList.add('collapsed');
        document.querySelector('.sidebar-resize').classList.add('collapsed');
        return;
      }
      switchView(view);
    });
  });

  // Deep links: react to manual hash edits / back-forward.
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v && v !== state.currentView) switchView(v, { fromHash: true });
  });
}

/**
 * Apply the view referenced by the URL. Called AFTER login (a pre-auth fetch
 * would 401 and leave the page empty), so panels only load once authenticated.
 */
export function applyInitialView() {
  const v = viewFromHash() || 'overview';   // Dashboard is the default view
  switchView(v, { fromHash: true });
}

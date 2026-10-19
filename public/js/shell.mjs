// shell.mjs — Preact app shell: activity rail, routing, page hosting.
//
// Two families of view, exactly as before:
//   * Console views (dashboard/system/containers/terminal) render full-width
//     into #consoleArea — they are Preact components declared in CONSOLE_VIEWS.
//   * IDE views (explorer/search/git) keep the classic sidebar + editor area.
//     Those panels are still plain-DOM modules mounted into #sidebar; the IDE
//     layout itself stays in index.html because CodeMirror owns that area.
//
// Adding a console page = one entry in CONSOLE_VIEWS. Nothing else changes.
import { html, render, useEffect } from '/ui.mjs';
import { get, set, useStore, isAuthed } from './store.mjs';
import { toast } from './api.mjs';
import Dashboard from './views/dashboard.mjs';
import SystemPage from './views/system.mjs';
import ContainersPage from './views/containers.mjs';
import TerminalPage from './views/terminal.mjs';

/** Console pages: full-width, Preact-rendered. */
export const CONSOLE_VIEWS = {
  overview: {
    title: 'Dashboard',
    page: Dashboard,
    icon: html`<path d="M3 12a9 9 0 1 1 18 0" /><path d="m12 12 4-4" /><circle cx="12" cy="12" r="1.4" />`,
  },
  services: {
    title: 'System',
    page: SystemPage,
    icon: html`<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /><circle cx="12" cy="12" r="3" />`,
  },
  containers: {
    title: 'Containers',
    page: ContainersPage,
    icon: html`<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" />`,
  },
  terminal: {
    title: 'Terminal',
    page: TerminalPage,
    icon: html`<polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />`,
  },
};

/** IDE views: keep the sidebar; `panel` is the sidebar panel id in index.html. */
export const IDE_VIEWS = {
  explorer: { title: 'Explorer (Ctrl+Shift+E)', panel: 'panel-explorer',
    icon: html`<path d="M15.5 2H8.6a1.6 1.6 0 0 0-1.6 1.6v12.8a1.6 1.6 0 0 0 1.6 1.6h9.8a1.6 1.6 0 0 0 1.6-1.6V6.5L15.5 2z" /><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" /><path d="M15 2v5h5" />` },
  search: { title: 'Search (Ctrl+Shift+F)', panel: 'panel-search',
    icon: html`<circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />` },
  git: { title: 'Source Control (Ctrl+Shift+G)', panel: 'panel-git',
    icon: html`<line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />` },
};

const ALL = { ...CONSOLE_VIEWS, ...IDE_VIEWS };

/** Console pages that need the server's `--admin` flag. */
const ADMIN_ONLY = new Set(['overview', 'services', 'containers']);

// Deep links from before the console reorganisation still resolve.
const ALIAS = { users: 'services', cron: 'services', network: 'services', access: 'services', processes: 'overview' };

function normalize(view) {
  const v = ALIAS[view] || view;
  return v && ALL[v] ? v : '';
}

function viewFromHash() {
  const m = /^#\/?([a-z]+)/.exec(location.hash || '');
  return normalize((m && m[1]) || '');
}

// --- rail ------------------------------------------------------------------

function iconNode(def) {
  return html`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${def.icon}</svg>`;
}

function Rail() {
  const store = useStore();
  const view = store.view;
  const info = store.serverInfo;
  const btn = (id, def) => html`<button key=${id} class=${'act-btn' + (view === id ? ' active' : '')}
      data-view=${id} title=${def.title} onClick=${() => toggle(id)}>${iconNode(def)}</button>`;

  return html`<div class="activitybar" id="activitybar">
    ${Object.entries(CONSOLE_VIEWS).map(([id, def]) => (
      ADMIN_ONLY.has(id) && !(info && info.admin) ? null : btn(id, def)
    ))}
    <span class="act-sep"></span>
    ${Object.entries(IDE_VIEWS).map(([id, def]) => btn(id, def))}
    <a class="act-btn act-btn-bottom" href="https://github.com/zhaxg/edlics-plus" target="_blank" rel="noopener" title="GitHub repository">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    </a>
  </div>`;
}

// --- page host -------------------------------------------------------------

/** Rendered into #consoleArea: the active console page, or nothing. */
function ConsoleHost() {
  const { view, authed } = useStore();
  const def = CONSOLE_VIEWS[view];
  // No data calls before the login gate — the API would answer 401.
  if (!def || !authed) return null;
  const Active = def.page;
  return html`<${Active} />`;
}

// --- layout ----------------------------------------------------------------

/** Show/hide the sidebar, console area and editor area for `view`. */
function applyLayout(view) {
  const isConsole = !!CONSOLE_VIEWS[view];
  const container = document.querySelector('.container');
  const consoleArea = document.getElementById('consoleArea');
  const editorArea = document.getElementById('editorArea');

  document.body.classList.toggle('console-mode', isConsole);
  container?.classList.toggle('console-view', isConsole);
  consoleArea?.classList.toggle('hidden', !isConsole);
  if (editorArea) editorArea.style.display = isConsole ? 'none' : '';

  for (const [v, def] of Object.entries(IDE_VIEWS)) {
    document.getElementById(def.panel)?.classList.toggle('hidden', v !== view);
  }
  if (!isConsole) {
    // Reveal the sidebar if it was collapsed.
    document.querySelector('.sidebar')?.classList.remove('collapsed');
    document.querySelector('.sidebar-resize')?.classList.remove('collapsed');
  }

  const title = document.getElementById('pageTitle');
  if (title) title.textContent = isConsole ? CONSOLE_VIEWS[view].title : '';
}

// --- navigation ------------------------------------------------------------

/** Switch view, syncing the URL hash and the DOM layout classes. */
export function switchView(view, opts = {}) {
  view = normalize(view);
  if (!view) return;

  if (view === 'terminal' && get().serverInfo && get().serverInfo.terminal === false) {
    toast('Terminal is disabled — start the server with --terminal to enable it', true);
    return;
  }
  // Console pages need --admin; ignore the request otherwise.
  if (ADMIN_ONLY.has(view) && get().serverInfo && !get().serverInfo.admin) return;

  set({ view });
  if (!opts.fromHash) {
    const want = '#/' + view;
    if (location.hash !== want) {
      try { history.replaceState(null, '', want); } catch { location.hash = want; }
    }
  }
  applyLayout(view);
  document.dispatchEvent(new CustomEvent('view-changed', { detail: { view } }));
}

/** Click handler: re-clicking the active IDE view collapses the sidebar. */
function toggle(view) {
  if (IDE_VIEWS[view] && get().view === view && !document.querySelector('.sidebar')?.classList.contains('collapsed')) {
    document.querySelector('.sidebar')?.classList.add('collapsed');
    document.querySelector('.sidebar-resize')?.classList.add('collapsed');
    return;
  }
  switchView(view);
}

/** Apply the view referenced by the URL (after login — pre-auth calls 401). */
export function applyInitialView() {
  switchView(viewFromHash() || 'overview', { fromHash: true });
}

/** Mount the rail + page host. */
export function mountShell(railEl, consoleEl) {
  render(html`<${Rail} />`, railEl);
  render(html`<${ConsoleHost} />`, consoleEl);

  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v && v !== get().view) switchView(v, { fromHash: true });
  });

  // The rail hides console buttons until /api/info says --admin is on.
  document.addEventListener('server-info', () => render(html`<${Rail} />`, railEl));
}

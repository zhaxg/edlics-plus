// containers.mjs — Docker board with tab switching (Containers | Compose).
//
// Each item is a 3-column grid:
//   col 1: badge (icon + status dot) spanning all rows
//   col 2: three rows — title / metrics / image·status (containers) or
//          name / status·count·created / config path (compose)
//   col 3: action buttons, vertically centred — ALL shown as buttons; only the
//          port mapping is a dropdown (multiple port links).
import { api, escapeHtml, toast, confirmDialog, spinner } from './api.mjs';
import { serverInfo } from './state.mjs';
import { runCommandInTerminal } from './terminal-ui.mjs';

let data = null;
let stats = {};        // name|id12 -> usage (loaded in a second, slower request)
let statsLoading = false;
let tab = 'containers';
const openLogs = new Set();

const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);
const WHALE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';

// Inline SVG icons for the action buttons (paths supplied by the user;
// stroke/fill set to currentColor so they follow the app theme).
const S = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const F = (d, vb = '0 0 24 24') => `<svg viewBox="${vb}" width="15" height="15" fill="currentColor">${d}</svg>`;
const IC = {
  ports: S('<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>'),
  logs: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4.00195C18.175 4.01406 19.3529 4.11051 20.1213 4.87889C21 5.75757 21 7.17179 21 10.0002V16.0002C21 18.8286 21 20.2429 20.1213 21.1215C19.2426 22.0002 17.8284 22.0002 15 22.0002H9C6.17157 22.0002 4.75736 22.0002 3.87868 21.1215C3 20.2429 3 18.8286 3 16.0002V10.0002C3 7.17179 3 5.75757 3.87868 4.87889C4.64706 4.11051 5.82497 4.01406 8 4.00195"/><path d="M10.5 14L17 14"/><path d="M7 14H7.5"/><path d="M7 10.5H7.5"/><path d="M7 17.5H7.5"/><path d="M10.5 10.5H17"/><path d="M10.5 17.5H17"/><path d="M8 3.5C8 2.67157 8.67157 2 9.5 2H14.5C15.3284 2 16 2.67157 16 3.5V4.5C16 5.32843 15.3284 6 14.5 6H9.5C8.67157 6 8 5.32843 8 4.5V3.5Z"/></svg>',
  console: S('<path d="m5 7l5 5l-5 5m7 2h7"/>'),
  start: S('<path d="M5 5v14a2 2 0 0 0 2.75 1.84L20 13.74a2 2 0 0 0 0-3.5L7.75 3.14A2 2 0 0 0 5 4.89"/>'),
  restart: S('<path d="M19.933 13.041a8 8 0 1 1-9.925-8.788c3.899-1 7.935 1.007 9.425 4.747"/><path d="M20 4v5h-5"/>'),
  stop: S('<path d="M7 6a7.75 7.75 0 1 0 10 0m-5-2v8"/>'),
  build: F('<path d="m8.354 5.854l2-2a.5.5 0 0 0-.708-.707L8.5 4.293V.5a.5.5 0 0 0-1 0v3.793L6.354 3.147a.5.5 0 0 0-.707.707l2 2a.5.5 0 0 0 .707 0"/><path d="M15 12.5c0 1.379-1.121 2.5-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5v-6a.5.5 0 0 1 1 0v6c0 .827.673 1.5 1.5 1.5h9c.827 0 1.5-.673 1.5-1.5v-6a.5.5 0 0 1 1 0z"/><path d="M4 10a1 1 0 1 0 0-2a1 1 0 0 0 0 2m4 0a1 1 0 1 0 0-2a1 1 0 0 0 0 2m-2 3a1 1 0 1 0 0-2a1 1 0 0 0 0 2m4 0a1 1 0 1 0 0-2a1 1 0 0 0 0 2m2-3a1 1 0 1 0 0-2a1 1 0 0 0 0 2"/>', '0 0 16 16'),
  clean: F('<path d="m19.36 2.72l1.42 1.42l-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32zM5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09l7.44 7.44l-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58"/>'),
  del: F('<path d="M20 6a1 1 0 0 1 .117 1.993L20 8h-.081L19 19a3 3 0 0 1-2.824 2.995L16 22H8c-1.598 0-2.904-1.249-2.992-2.75l-.005-.167L4.08 8H4a1 1 0 0 1-.117-1.993L4 6zm-10 4a1 1 0 0 0-1 1v6a1 1 0 0 0 2 0v-6a1 1 0 0 0-1-1m4 0a1 1 0 0 0-1 1v6a1 1 0 0 0 2 0v-6a1 1 0 0 0-1-1m0-8a2 2 0 0 1 2 2a1 1 0 0 1-1.993.117L14 4h-4l-.007.117A1 1 0 0 1 8 4a2 2 0 0 1 1.85-1.995L10 2z"/>'),
};
const ibtn = (attr, key, title, danger) =>
  `<button class="icon-btn sm ctr-ibtn${danger ? ' danger' : ''}" ${attr} title="${escapeHtml(title)}">${IC[key]}</button>`;

const dotClass = state => state === 'running' ? 'ok' : state === 'exited' ? 'off' : 'warn';

function badge(state, title) {
  return `<div class="ctr-badge" title="${escapeHtml(title || state || '')}">
      <span class="ctr-badge-ico">${WHALE}</span>
      <span class="ctr-badge-dot ${dotClass(state)}"></span>
    </div>`;
}

function portUrl(p) {
  const host = (!p.host || /^(0\.0\.0\.0|::|\[::\]|:::)$/.test(p.host)) ? location.hostname : p.host;
  return `http://${host}:${p.hostPort}`;
}

// --- floating menu (used ONLY for the port dropdown) -----------------------

function closeMenus() { document.querySelectorAll('.floating-menu').forEach(m => m.remove()); }
function openMenu(anchor, items) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'floating-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.textContent = it.label;
    b.addEventListener('click', () => { closeMenus(); it.onClick && it.onClick(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}

// --- container actions -----------------------------------------------------

async function containerAction(id, action, label) {
  if (action === 'stop' || action === 'restart') {
    const okGo = await confirmDialog(`${label} container "${id}"?`, { title: label, okLabel: label, danger: action === 'stop' });
    if (!okGo) return;
  }
  try {
    const r = await api('POST', '/api/sys/containers/action', { id, action });
    if (r.error) toast(r.error, true); else toast(`${label} ${id} ok`);
  } catch (e) { toast('Action failed: ' + e.message, true); }
  refreshContainers();
}

function portLinks(c) {
  return (c.ports || []).map(p => ({ label: `:${p.hostPort} → ${p.containerPort}/${p.proto}`, onClick: () => window.open(portUrl(p), '_blank', 'noopener') }));
}

function containerActions(c) {
  const b = [];
  if (c.ports && c.ports.length) b.push(ibtn('data-act="ports"', 'ports', 'Mapped ports'));
  b.push(ibtn('data-act="logs"', 'logs', 'Logs'));
  b.push(ibtn('data-act="console"', 'console', `Console — docker exec -it ${c.name} sh`));
  if (canWrite()) {
    if (c.state !== 'running') b.push(ibtn('data-act="start"', 'start', 'Start'));
    b.push(ibtn('data-act="restart"', 'restart', 'Restart'));
    b.push(ibtn('data-act="stop"', 'stop', 'Stop', true));
  }
  return `<div class="ctr-actions">${b.join('')}</div>`;
}

function containerItem(c) {
  const open = openLogs.has(c.id);
  const s = stats[c.name] || stats[c.id.slice(0, 12)] || {};
  const net = (s.net || '').split('/').map(x => x.trim());
  const tag = c.project ? `<span class="ctr-tag">${escapeHtml(c.project)}</span>` : '';
  const metrics = [
    s.mem ? `<span class="ctr-metric"><b>RAM</b> ${escapeHtml(s.mem)}</span>` : null,
    s.cpu ? `<span class="ctr-metric"><b>CPU</b> ${escapeHtml(s.cpu)}</span>` : null,
    net[0] ? `<span class="ctr-metric"><b>↓</b> ${escapeHtml(net[0])}</span>` : null,
    net[1] ? `<span class="ctr-metric"><b>↑</b> ${escapeHtml(net[1])}</span>` : null,
  ].filter(Boolean).join('');
  const fallback = statsLoading ? '<span class="ctr-metric">loading stats…</span>' : '<span class="ctr-metric">no stats</span>';
  return `<div class="ilist-item ctr" data-id="${escapeHtml(c.id)}">
    ${badge(c.state, c.state)}
    <div class="ctr-main">
      <div class="ctr-name"><span class="ctr-name-text">${escapeHtml(c.name)}</span></div>
      <div class="ctr-sub">${metrics || fallback}<span class="ctr-meta mono">${escapeHtml(c.image)}${c.status ? ' · ' + escapeHtml(c.status) : ''}</span></div>
    </div>
    <div class="ctr-tagcol">${tag}</div>
    ${containerActions(c)}
    <pre class="svc-logs${open ? '' : ' hidden'}" data-clogbox="${escapeHtml(c.id)}"></pre>
  </div>`;
}

// --- compose actions -------------------------------------------------------

async function composeAction(name, action, label, confirmMsg) {
  if (confirmMsg) {
    const okGo = await confirmDialog(confirmMsg, { title: label, okLabel: label, danger: true });
    if (!okGo) return;
  }
  try {
    const r = await api('POST', '/api/sys/containers/compose', { name, action });
    if (r.error) toast(r.error, true); else toast(`${label} ${name} ok`);
  } catch (e) { toast('Action failed: ' + e.message, true); }
  refreshContainers();
}

function composeItem(p) {
  const dt = p.created ? new Date(p.created) : null;
  const created = dt && !isNaN(dt) ? dt.toLocaleDateString() : (p.created || '').slice(0, 10);
  const running = /(^|\()up|running/i.test(p.status || '');
  const actions = canWrite()
    ? `<div class="ctr-actions">
         ${ibtn('data-cact="up"', 'start', 'Start (up -d)')}
         ${ibtn('data-cact="stop"', 'stop', 'Stop')}
         ${ibtn('data-cact="build"', 'build', 'Build images')}
         ${ibtn('data-cact="down"', 'clean', 'Clean up (down)')}
         ${ibtn('data-cact="downv"', 'del', 'Delete (down -v)', true)}
       </div>`
    : '<div class="ctr-actions"></div>';
  return `<div class="ilist-item ctr" data-project="${escapeHtml(p.name)}">
    ${badge(running ? 'running' : 'exited', p.status)}
    <div class="ctr-main">
      <div class="ctr-name">${escapeHtml(p.name)}</div>
      <div class="ctr-sub">
        <span class="ctr-metric"><b>containers</b> ${p.count || 0}${typeof p.running === 'number' ? ' (' + p.running + ' up)' : ''}</span>
        ${created ? `<span class="ctr-metric"><b>created</b> ${escapeHtml(created)}</span>` : ''}
        <span class="ctr-meta mono">${escapeHtml(p.configFiles)}</span>
      </div>
    </div>
    <div class="ctr-tagcol"><span class="ctr-tag">${escapeHtml(p.status || '')}</span></div>
    ${actions}
  </div>`;
}

// --- render ----------------------------------------------------------------

function render() {
  const box = document.getElementById('containersContent');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  if (!data.available) { box.innerHTML = '<div class="panel-placeholder">Docker is not available</div>'; return; }

  if (tab === 'compose') {
    box.innerHTML = data.compose.length
      ? '<div class="ilist">' + data.compose.map(composeItem).join('') + '</div>'
      : '<div class="panel-placeholder">No compose projects</div>';
    box.querySelectorAll('.ctr[data-project]').forEach(row => {
      const name = row.dataset.project;
      row.querySelectorAll('[data-cact]').forEach(btn => {
        const a = btn.dataset.cact;
        btn.addEventListener('click', () => {
          if (a === 'down') return composeAction(name, 'down', 'Clean up', `Bring down project "${name}" (containers removed, volumes kept)?`);
          if (a === 'downv') return composeAction(name, 'downv', 'Delete', `Delete project "${name}"? Containers AND volumes will be removed.`);
          composeAction(name, a, a === 'up' ? 'Start' : a === 'stop' ? 'Stop' : 'Build');
        });
      });
    });
    return;
  }

  box.innerHTML = data.containers.length
    ? '<div class="ilist">' + data.containers.map(containerItem).join('') + '</div>'
    : '<div class="panel-placeholder">No containers</div>';

  box.querySelectorAll('.ctr[data-id]').forEach(row => {
    const id = row.dataset.id;
    const c = (data.containers || []).find(x => x.id === id) || { id, name: id };
    row.querySelectorAll('[data-act]').forEach(btn => {
      const a = btn.dataset.act;
      if (a === 'ports') btn.addEventListener('click', e => { e.stopPropagation(); openMenu(btn, portLinks(c)); });
      else if (a === 'logs') btn.addEventListener('click', () => toggleLogs(id));
      else if (a === 'console') btn.addEventListener('click', () => runCommandInTerminal(`docker exec -it ${c.name} sh`));
      else btn.addEventListener('click', () => containerAction(id, a, a === 'start' ? 'Start' : a === 'restart' ? 'Restart' : 'Stop'));
    });
  });
}

async function toggleLogs(id) {
  const box = document.querySelector(`[data-clogbox="${CSS.escape(id)}"]`);
  if (!box) return;
  if (openLogs.has(id)) { openLogs.delete(id); box.classList.add('hidden'); return; }
  openLogs.add(id);
  box.classList.remove('hidden');
  box.textContent = 'Loading…';
  try {
    const d = await api('GET', `/api/sys/containers/logs?id=${encodeURIComponent(id)}&tail=200`);
    box.textContent = d.error ? d.error : (d.lines || []).join('\n') || '(no output)';
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.textContent = 'Failed: ' + e.message; }
}

function renderTabs() {
  const bar = document.getElementById('containerTabs');
  if (!bar) return;
  const counts = { containers: (data && data.containers || []).length, compose: (data && data.compose || []).length };
  bar.querySelectorAll('button').forEach(b => {
    const k = b.dataset.ctab;
    b.textContent = `${k.charAt(0).toUpperCase() + k.slice(1)} (${counts[k] || 0})`;
    b.classList.toggle('active', k === tab);
  });
}

/** Slow second step: fetch live stats and re-render. */
async function loadStats() {
  statsLoading = true;
  if (tab === 'containers') render();
  try {
    const r = await api('GET', '/api/sys/containers/stats');
    stats = (r && r.stats) || {};
  } catch { stats = {}; }
  statsLoading = false;
  if (tab === 'containers') render();
}

export async function refreshContainers() {
  // Step 1 (fast): list + compose, render immediately.
  try { data = await api('GET', '/api/sys/containers'); } catch { data = null; }
  renderTabs();
  render();
  // Step 2 (slow): live stats.
  loadStats();
}

export function initContainers() {
  const bar = document.getElementById('containerTabs');
  if (bar) bar.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { tab = btn.dataset.ctab; renderTabs(); render(); }));
  const btn = document.getElementById('btnContainersRefresh');
  if (btn) btn.addEventListener('click', refreshContainers);
  document.addEventListener('view-changed', e => { if (e.detail && e.detail.view === 'containers') refreshContainers(); });
}

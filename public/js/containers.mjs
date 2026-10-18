// containers.mjs — Docker board with tab switching (Containers | Compose).
//
// Container item: icon + status dot + name; subtitle rows = project, memory,
// CPU, inbound/outbound traffic; right side quick restart + a menu with
// mapped ports (open in a new tab), logs, console (docker exec), restart, stop.
// Compose item: icon + dot + name; subtitle = status · count · created; actions
// start/stop + build/clean/delete.
import { api, escapeHtml, toast, confirmDialog, spinner } from './api.mjs';
import { serverInfo } from './state.mjs';
import { runCommandInTerminal } from './terminal-ui.mjs';

let data = null;
let tab = 'containers';
const openLogs = new Set();

const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);
const WHALE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';

function dot(state) {
  const cls = state === 'running' ? 'ok' : state === 'exited' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}" title="${escapeHtml(state || '')}"></span>`;
}

function portUrl(p) {
  const host = (!p.host || /^(0\.0\.0\.0|::|\[::\]|:::)$/.test(p.host)) ? location.hostname : p.host;
  return `http://${host}:${p.hostPort}`;
}

// --- floating menu ---------------------------------------------------------

function closeMenus() { document.querySelectorAll('.floating-menu').forEach(m => m.remove()); }
function openMenu(anchor, items) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'floating-menu';
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => {
      closeMenus();
      if (it.onClick) it.onClick();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { closeMenus(); document.removeEventListener('keydown', esc); } });
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

function containerMenu(c) {
  const items = [];
  if (c.ports && c.ports.length) {
    for (const p of c.ports) items.push({ label: `Open :${p.hostPort} → ${p.containerPort}/${p.proto}`, onClick: () => window.open(portUrl(p), '_blank', 'noopener') });
    items.push({ sep: true });
  }
  items.push({ label: 'Logs', onClick: () => toggleLogs(c.id) });
  items.push({ label: 'Console (sh)', onClick: () => runCommandInTerminal(`docker exec -it ${c.name} sh`) });
  items.push({ sep: true });
  if (c.state !== 'running') items.push({ label: 'Start', onClick: () => containerAction(c.id, 'start', 'Start') });
  items.push({ label: 'Restart', onClick: () => containerAction(c.id, 'restart', 'Restart') });
  items.push({ label: 'Stop', danger: true, onClick: () => containerAction(c.id, 'stop', 'Stop') });
  return items;
}

function containerItem(c) {
  const open = openLogs.has(c.id);
  const s = c.stats || {};
  const net = (s.net || '').split('/').map(x => x.trim());
  const metrics = [
    c.project ? `<span class="ctr-tag">${escapeHtml(c.project)}</span>` : null,
    s.mem ? `<span class="ctr-metric"><b>RAM</b> ${escapeHtml(s.mem)}</span>` : null,
    s.cpu ? `<span class="ctr-metric"><b>CPU</b> ${escapeHtml(s.cpu)}</span>` : null,
    net[0] ? `<span class="ctr-metric"><b>↓</b> ${escapeHtml(net[0])}</span>` : null,
    net[1] ? `<span class="ctr-metric"><b>↑</b> ${escapeHtml(net[1])}</span>` : null,
  ].filter(Boolean).join('');
  const actions = canWrite()
    ? `<span class="ctr-actions">
         ${c.state !== 'running' ? `<button class="icon-btn sm" data-act="start" title="Start">▶</button>` : ''}
         <button class="icon-btn sm" data-act="restart" title="Restart">⟳</button>
         <button class="icon-btn sm" data-menu title="More">⋯</button>
       </span>`
    : '<span class="ctr-actions"><button class="icon-btn sm" data-menu title="More">⋯</button></span>';
  return `<div class="ilist-item ctr" data-id="${escapeHtml(c.id)}">
    <div class="ilist-head"><span class="ctr-ico">${WHALE}</span>${dot(c.state)}
      <span class="ilist-title">${escapeHtml(c.name)}</span>${actions}</div>
    <div class="ctr-sub">${metrics || '<span class="ilist-sub">no stats</span>'}</div>
    <div class="ilist-sub mono">${escapeHtml(c.image)}${c.status ? ' · ' + escapeHtml(c.status) : ''}</div>
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
  const badge = /(^|\()up|running/i.test(p.status) ? 'ok' : 'warn';
  const actions = canWrite()
    ? `<span class="ctr-actions">
         <button class="icon-btn sm" data-cact="up" title="Start">Start</button>
         <button class="icon-btn sm" data-cact="stop" title="Stop">Stop</button>
         <button class="icon-btn sm" data-cmenu title="More">⋯</button>
       </span>`
    : '<span class="ctr-actions"><button class="icon-btn sm" data-cmenu title="More">⋯</button></span>';
  return `<div class="ilist-item ctr" data-project="${escapeHtml(p.name)}">
    <div class="ilist-head"><span class="ctr-ico">${WHALE}</span><span class="svc-dot ${badge}"></span>
      <span class="ilist-title">${escapeHtml(p.name)}</span>${actions}</div>
    <div class="ctr-sub">
      <span class="ctr-tag">${escapeHtml(p.status || '')}</span>
      <span class="ctr-metric"><b>containers</b> ${p.count || 0}${typeof p.running === 'number' ? ' (' + p.running + ' up)' : ''}</span>
      ${created ? `<span class="ctr-metric"><b>created</b> ${escapeHtml(created)}</span>` : ''}
    </div>
    <div class="ilist-sub mono">${escapeHtml(p.configFiles)}</div>
  </div>`;
}

function composeMenu(p) {
  return [
    { label: 'Build images', onClick: () => composeAction(p.name, 'build', 'Build') },
    { label: 'Clean up (down)', onClick: () => composeAction(p.name, 'down', 'Clean up', `Bring down project "${p.name}" (containers removed, volumes kept)?`) },
    { label: 'Delete (down -v)', danger: true, onClick: () => composeAction(p.name, 'downv', 'Delete', `Delete project "${p.name}"? Containers AND volumes will be removed.`) },
  ];
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
    wireCompose(box);
    return;
  }
  box.innerHTML = data.containers.length
    ? '<div class="ilist">' + data.containers.map(containerItem).join('') + '</div>'
    : '<div class="panel-placeholder">No containers</div>';
  wireContainers(box);
}

function wireContainers(box) {
  box.querySelectorAll('.ctr[data-id]').forEach(row => {
    const id = row.dataset.id;
    const c = (data.containers || []).find(x => x.id === id) || { id, name: id };
    const menuBtn = row.querySelector('[data-menu]');
    if (menuBtn) menuBtn.addEventListener('click', e => { e.stopPropagation(); openMenu(menuBtn, containerMenu(c)); });
    const startBtn = row.querySelector('[data-act="start"]');
    if (startBtn) startBtn.addEventListener('click', () => containerAction(id, 'start', 'Start'));
    const rBtn = row.querySelector('[data-act="restart"]');
    if (rBtn) rBtn.addEventListener('click', () => containerAction(id, 'restart', 'Restart'));
  });
}

function wireCompose(box) {
  box.querySelectorAll('.ctr[data-project]').forEach(row => {
    const name = row.dataset.project;
    const p = (data.compose || []).find(x => x.name === name) || { name };
    const up = row.querySelector('[data-cact="up"]');
    if (up) up.addEventListener('click', () => composeAction(name, 'up', 'Start'));
    const stop = row.querySelector('[data-cact="stop"]');
    if (stop) stop.addEventListener('click', () => composeAction(name, 'stop', 'Stop'));
    const mb = row.querySelector('[data-cmenu]');
    if (mb) mb.addEventListener('click', e => { e.stopPropagation(); openMenu(mb, composeMenu(p)); });
  });
  // logs belong to the containers tab; nothing extra here
}

async function toggleLogs(id) {
  // switch to containers tab if needed
  if (tab !== 'containers') { tab = 'containers'; renderTabs(); render(); }
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

export async function refreshContainers() {
  try { data = await api('GET', '/api/sys/containers'); } catch { data = null; }
  renderTabs();
  render();
}

export function initContainers() {
  const bar = document.getElementById('containerTabs');
  if (bar) bar.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { tab = btn.dataset.ctab; renderTabs(); render(); }));
  const btn = document.getElementById('btnContainersRefresh');
  if (btn) btn.addEventListener('click', refreshContainers);
  document.addEventListener('view-changed', e => { if (e.detail && e.detail.view === 'containers') refreshContainers(); });
}

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
let tab = 'containers';
const openLogs = new Set();

const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);
const WHALE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';

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
  if (c.ports && c.ports.length) b.push(`<button class="btn sm" data-act="ports" title="Mapped ports">Ports ▾</button>`);
  b.push(`<button class="btn sm" data-act="logs">Logs</button>`);
  b.push(`<button class="btn sm" data-act="console" title="docker exec -it ${escapeHtml(c.name)} sh">Console</button>`);
  if (canWrite()) {
    if (c.state !== 'running') b.push(`<button class="btn sm" data-act="start">Start</button>`);
    b.push(`<button class="btn sm" data-act="restart">Restart</button>`);
    b.push(`<button class="btn sm danger" data-act="stop">Stop</button>`);
  }
  return `<div class="ctr-actions">${b.join('')}</div>`;
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
  return `<div class="ilist-item ctr" data-id="${escapeHtml(c.id)}">
    ${badge(c.state, c.state)}
    <div class="ctr-main">
      <div class="ctr-name">${escapeHtml(c.name)}</div>
      <div class="ctr-sub">${metrics || '<span class="muted">no stats</span>'}</div>
      <div class="ctr-meta mono">${escapeHtml(c.image)}${c.status ? ' · ' + escapeHtml(c.status) : ''}</div>
    </div>
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
         <button class="btn sm" data-cact="up">Start</button>
         <button class="btn sm" data-cact="stop">Stop</button>
         <button class="btn sm" data-cact="build">Build</button>
         <button class="btn sm" data-cact="down">Clean up</button>
         <button class="btn sm danger" data-cact="downv">Delete</button>
       </div>`
    : '<div class="ctr-actions"></div>';
  return `<div class="ilist-item ctr" data-project="${escapeHtml(p.name)}">
    ${badge(running ? 'running' : 'exited', p.status)}
    <div class="ctr-main">
      <div class="ctr-name">${escapeHtml(p.name)}</div>
      <div class="ctr-sub">
        <span class="ctr-tag">${escapeHtml(p.status || '')}</span>
        <span class="ctr-metric"><b>containers</b> ${p.count || 0}${typeof p.running === 'number' ? ' (' + p.running + ' up)' : ''}</span>
        ${created ? `<span class="ctr-metric"><b>created</b> ${escapeHtml(created)}</span>` : ''}
      </div>
      <div class="ctr-meta mono">${escapeHtml(p.configFiles)}</div>
    </div>
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

// services.mjs — systemd Services panel: list, filter, lifecycle actions, logs.
//
// Actions are only offered when the server has --admin-write; the server
// re-checks and audits regardless (defence in depth).
import { api, escapeHtml, toast, confirmDialog, setBusy, spinner } from './api.mjs';
import { serverInfo } from './state.mjs';

let loaded = false;
let filter = '';
let units = [];
const openLogs = new Set();     // unit names with an expanded log view

const ACTIVE_CLASS = {
  active: 'ok', failed: 'err', activating: 'warn', deactivating: 'warn',
  inactive: 'off', reloading: 'warn',
};

function shortName(unit) { return unit.replace(/\.service$/, ''); }

function canWrite() { return !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly); }

function dot(active) {
  return `<span class="svc-dot ${ACTIVE_CLASS[active] || 'off'}" title="${escapeHtml(active)}"></span>`;
}

function renderList() {
  const box = document.getElementById('servicesList');
  if (!box) return;
  const q = filter.toLowerCase();
  const rows = q
    ? units.filter(u => u.name.toLowerCase().includes(q) || (u.description || '').toLowerCase().includes(q))
    : units;
  if (rows.length === 0) {
    box.innerHTML = `<div class="panel-placeholder">${units.length ? 'No matches' : 'No services'}</div>`;
    return;
  }
  box.innerHTML = rows.map(u => {
    const actions = canWrite()
      ? `<div class="svc-actions">
           <button data-act="start" data-unit="${escapeHtml(u.name)}">start</button>
           <button data-act="restart" data-unit="${escapeHtml(u.name)}">restart</button>
           <button data-act="stop" data-unit="${escapeHtml(u.name)}">stop</button>
         </div>`
      : '';
    const logsOpen = openLogs.has(u.name);
    return `<div class="service-row" data-unit="${escapeHtml(u.name)}">
      <div class="svc-head">
        ${dot(u.active)}
        <span class="svc-name" title="${escapeHtml(u.name)}">${escapeHtml(shortName(u.name))}</span>
        <span class="svc-sub">${escapeHtml(u.sub || '')}</span>
        <button class="svc-logs-btn" data-logs="${escapeHtml(u.name)}" title="Show journal">log</button>
      </div>
      <div class="svc-desc">${escapeHtml(u.description || '')}</div>
      ${actions}
      <pre class="svc-logs${logsOpen ? '' : ' hidden'}" data-logbox="${escapeHtml(u.name)}"></pre>
    </div>`;
  }).join('');

  box.querySelectorAll('.svc-logs-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleLogs(btn.dataset.logs));
  });
  box.querySelectorAll('.svc-actions button').forEach(btn => {
    btn.addEventListener('click', () => doAction(btn.dataset.unit, btn.dataset.act, btn));
  });
}

async function toggleLogs(unit) {
  const box = document.querySelector(`[data-logbox="${CSS.escape(unit)}"]`);
  if (!box) return;
  if (openLogs.has(unit)) { openLogs.delete(unit); box.classList.add('hidden'); return; }
  openLogs.add(unit);
  box.classList.remove('hidden');
  box.textContent = 'Loading…';
  try {
    const data = await api('GET', `/api/sys/services/logs?unit=${encodeURIComponent(unit)}&lines=200`);
    if (data.error) { box.textContent = data.error; return; }
    if (!data.lines || data.lines.length === 0) { box.textContent = '(no journal entries)'; return; }
    box.innerHTML = data.lines.map(l => {
      const t = new Date(l.ts).toLocaleTimeString();
      const cls = l.priority <= 3 ? 'log-err' : l.priority === 4 ? 'log-warn' : '';
      return `<span class="${cls}">${escapeHtml(t)} ${escapeHtml(l.message)}</span>`;
    }).join('\n');
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.textContent = 'Failed: ' + e.message; }
}

async function doAction(unit, action, btn) {
  if (!canWrite()) return;
  const label = action.charAt(0).toUpperCase() + action.slice(1);
  if (action === 'stop' || action === 'restart') {
    const okGo = await confirmDialog(`${label} ${unit}?`, { title: label + ' service', okLabel: label, danger: true });
    if (!okGo) return;
  }
  setBusy(btn, true);
  try {
    const res = await api('POST', '/api/sys/services/action', { unit, action });
    if (res.error) toast(res.error, true);
    else toast(`${label} ${shortName(unit)} ok`);
  } catch (e) { toast('Action failed: ' + e.message, true); }
  setBusy(btn, false);
  refreshServices();
}

export function refreshServices() {
  const box = document.getElementById('servicesList');
  if (box && !loaded) box.innerHTML = spinner('Loading…');
  api('GET', '/api/sys/services' + (loaded ? '?refresh=1' : ''))
    .then(data => {
      if (!data || data.error) { if (box) box.innerHTML = `<div class="panel-placeholder">${escapeHtml((data && data.error) || 'Failed to load services')}</div>`; return; }
      units = data.units || [];
      loaded = true;
      renderList();
    })
    .catch(e => { if (box) box.innerHTML = `<div class="panel-placeholder">Failed: ${escapeHtml(e.message)}</div>`; });
}

export function initServices() {
  const filterInput = document.getElementById('servicesFilter');
  if (filterInput) {
    filterInput.addEventListener('input', () => { filter = filterInput.value; renderList(); });
  }
  const btn = document.getElementById('btnServicesRefresh');
  if (btn) btn.addEventListener('click', refreshServices);

  document.querySelector('.act-btn[data-view="services"]')?.addEventListener('click', () => {
    setTimeout(refreshServices, 0);
  });
}

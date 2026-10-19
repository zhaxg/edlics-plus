// services.mjs — Services page: tab (Services | Scheduled) + master/detail.
//
// Services tab: left = unit list, right = unit file (systemctl cat) + journal.
// Scheduled tab: delegated to cron.mjs (its own list + detail).
import { api, escapeHtml, toast, confirmDialog, setBusy, spinner, loadJournalInto } from './api.mjs';
import { serverInfo } from './state.mjs';
import { refreshCron, initCron } from './cron.mjs';
import { refreshLogs, initLogs } from './logs.mjs';
import { refreshNetwork } from './network.mjs';
import { refreshUsers } from './users.mjs';
import { refreshDisk, initDisk } from './disk.mjs';

let units = [];
let loaded = false;
let filter = '';
let selected = null;
let tab = 'services';
let showSystem = false;   // hide distro-provided (vendor) units by default

const ACTIVE_CLASS = { active: 'ok', failed: 'err', activating: 'warn', deactivating: 'warn', inactive: 'off', reloading: 'warn' };
const shortName = u => u.replace(/\.service$/, '');
const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);

function dot(active) { return `<span class="svc-dot ${ACTIVE_CLASS[active] || 'off'}" title="${escapeHtml(active || '')}"></span>`; }

function renderList() {
  const box = document.getElementById('servicesList');
  if (!box) return;
  const q = filter.toLowerCase();
  // Distro-provided ("system") units are hidden unless the toggle is on.
  const base = showSystem ? units : units.filter(u => u.origin !== 'system');
  const rows = q ? base.filter(u => u.name.toLowerCase().includes(q) || (u.description || '').toLowerCase().includes(q)) : base;
  const toggle = document.getElementById('svcSystemToggle');
  if (toggle) {
    const sysCount = units.filter(u => u.origin === 'system').length;
    toggle.textContent = `system (${sysCount})`;
    toggle.classList.toggle('active', showSystem);
  }
  if (!rows.length) {
    box.innerHTML = `<div class="panel-placeholder">${units.length ? (q ? 'No matches' : 'No admin services — toggle "system" to show distro services') : 'No services'}</div>`;
    return;
  }
  box.innerHTML = rows.map(u => `
    <div class="ilist-item list-item${u.name === selected ? ' selected' : ''}" data-unit="${escapeHtml(u.name)}">
      <div class="ilist-head">${dot(u.active)}<span class="ilist-title">${escapeHtml(shortName(u.name))}</span><span class="ilist-meta">${escapeHtml(u.sub || '')}</span></div>
      <div class="ilist-sub">${escapeHtml(u.description || '')}${u.origin === 'system' ? ' · <span class="muted">system</span>' : ''}</div>
    </div>`).join('');
  box.querySelectorAll('[data-unit]').forEach(el => el.addEventListener('click', () => selectUnit(el.dataset.unit)));
}

async function selectUnit(unit) {
  selected = unit;
  renderList();
  const pane = document.getElementById('servicesDetail');
  if (!pane) return;
  const u = units.find(x => x.name === unit) || {};
  const actions = canWrite()
    ? `<div class="detail-actions">
         <button class="btn sm" data-act="start">Start</button>
         <button class="btn sm" data-act="restart">Restart</button>
         <button class="btn sm danger" data-act="stop">Stop</button>
       </div>` : '';
  pane.innerHTML = `
    <div class="detail-head">${dot(u.active)}<span class="detail-title">${escapeHtml(unit)}</span>
      <span class="ilist-meta">${escapeHtml(u.sub || '')}${u.load ? ' · ' + escapeHtml(u.load) : ''}</span></div>
    <div class="ilist-sub">${escapeHtml(u.description || '')}</div>
    ${actions}
    <div class="page-tabs detail-tabs" id="svcDetailTabs">
      <button data-dtab="unit" class="active">Unit file</button>
      <button data-dtab="logs">Logs</button>
    </div>
    <div class="detail-pane" id="svcPaneUnit"><pre class="file" id="unitFile">${spinner('Loading…')}</pre></div>
    <div class="detail-pane hidden" id="svcPaneLogs"><pre class="logs" id="unitLogs">${spinner('Loading…')}</pre></div>`;
  pane.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => doAction(unit, b.dataset.act, b)));
  const dtabs = pane.querySelector('#svcDetailTabs');
  if (dtabs) dtabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    dtabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    pane.querySelector('#svcPaneUnit').classList.toggle('hidden', b.dataset.dtab !== 'unit');
    pane.querySelector('#svcPaneLogs').classList.toggle('hidden', b.dataset.dtab !== 'logs');
  }));
  loadUnitFile(unit);
  loadJournalInto('unitLogs', unit);
}

async function loadUnitFile(unit) {
  const el = document.getElementById('unitFile');
  if (!el) return;
  try {
    const r = await api('GET', `/api/sys/services/unit?unit=${encodeURIComponent(unit)}`);
    el.textContent = r.error ? r.error : (r.content || '(empty)');
  } catch (e) { el.textContent = 'Failed: ' + e.message; }
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
    if (res.error) toast(res.error, true); else toast(`${label} ${shortName(unit)} ok`);
  } catch (e) { toast('Action failed: ' + e.message, true); }
  setBusy(btn, false);
  await refreshServices();
  if (selected === unit) selectUnit(unit);   // refresh the detail pane
}

export async function refreshServices() {
  const box = document.getElementById('servicesList');
  if (box && !loaded) box.innerHTML = spinner('Loading…');
  try {
    const data = await api('GET', '/api/sys/services' + (loaded ? '?refresh=1' : ''));
    if (!data || data.error) {
      if (box) box.innerHTML = `<div class="panel-placeholder">${escapeHtml((data && data.error) || 'Failed to load services')}</div>`;
      return;
    }
    units = data.units || [];
    loaded = true;
    renderList();
  } catch (e) {
    if (box) box.innerHTML = `<div class="panel-placeholder">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

const TAB_VIEW = {
  services: 'servicesSplit', scheduled: 'scheduledSplit', logs: 'logsView',
  interfaces: 'interfacesView', routes: 'routesView', ports: 'portsView',
  firewall: 'firewallView', disk: 'diskView', users: 'usersView',
};

function refreshTab(t) {
  switch (t) {
    case 'scheduled': return refreshCron();
    case 'logs': return refreshLogs();
    case 'interfaces': case 'routes': case 'ports': case 'firewall': return refreshNetwork();
    case 'disk': return refreshDisk();
    case 'users': return refreshUsers();
    default: return refreshServices();
  }
}

function setTab(t) {
  tab = t;
  const bar = document.getElementById('servicesTabs');
  if (bar) bar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.stab === t));
  for (const [k, id] of Object.entries(TAB_VIEW)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', k !== t);
  }
  refreshTab(t);
}

function refreshActive() { refreshTab(tab); }

export function initServices() {
  initCron();
  initLogs();
  initDisk();
  const filterInput = document.getElementById('servicesFilter');
  if (filterInput) filterInput.addEventListener('input', () => { filter = filterInput.value; renderList(); });
  const bar = document.getElementById('servicesTabs');
  if (bar) bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.stab)));
  const sysToggle = document.getElementById('svcSystemToggle');
  if (sysToggle) sysToggle.addEventListener('click', () => { showSystem = !showSystem; renderList(); });
  const btn = document.getElementById('btnServicesRefresh');
  if (btn) btn.addEventListener('click', refreshActive);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'services') refreshActive();
  });
}

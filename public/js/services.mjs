// services.mjs — Services page: tab (Services | Scheduled) + master/detail.
//
// Services tab: left = unit list, right = unit file (systemctl cat) + journal.
// Scheduled tab: delegated to cron.mjs (its own list + detail).
import { api, escapeHtml, toast, confirmDialog, setBusy, spinner, loadJournalInto } from './api.mjs';
import { serverInfo } from './state.mjs';
import { refreshCron, initCron } from './cron.mjs';

let units = [];
let loaded = false;
let filter = '';
let selected = null;
let tab = 'services';

const ACTIVE_CLASS = { active: 'ok', failed: 'err', activating: 'warn', deactivating: 'warn', inactive: 'off', reloading: 'warn' };
const shortName = u => u.replace(/\.service$/, '');
const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);

function dot(active) { return `<span class="svc-dot ${ACTIVE_CLASS[active] || 'off'}" title="${escapeHtml(active || '')}"></span>`; }

function renderList() {
  const box = document.getElementById('servicesList');
  if (!box) return;
  const q = filter.toLowerCase();
  const rows = q ? units.filter(u => u.name.toLowerCase().includes(q) || (u.description || '').toLowerCase().includes(q)) : units;
  if (!rows.length) {
    box.innerHTML = `<div class="panel-placeholder">${units.length ? 'No matches' : 'No services'}</div>`;
    return;
  }
  box.innerHTML = rows.map(u => `
    <div class="ilist-item list-item${u.name === selected ? ' selected' : ''}" data-unit="${escapeHtml(u.name)}">
      <div class="ilist-head">${dot(u.active)}<span class="ilist-title">${escapeHtml(shortName(u.name))}</span><span class="ilist-meta">${escapeHtml(u.sub || '')}</span></div>
      <div class="ilist-sub">${escapeHtml(u.description || '')}</div>
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
    <div class="detail-section-title">Unit file <span class="muted">(systemctl cat)</span></div>
    <pre class="file" id="unitFile">${spinner('Loading…')}</pre>
    <div class="detail-section-title">Logs <span class="muted">(journalctl)</span></div>
    <pre class="logs" id="unitLogs">${spinner('Loading…')}</pre>`;
  pane.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => doAction(unit, b.dataset.act, b)));
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

function setTab(t) {
  tab = t;
  const bar = document.getElementById('servicesTabs');
  if (bar) bar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.stab === t));
  document.getElementById('servicesSplit')?.classList.toggle('hidden', t !== 'services');
  document.getElementById('scheduledSplit')?.classList.toggle('hidden', t !== 'scheduled');
  if (t === 'scheduled') refreshCron();
}

function refreshActive() { if (tab === 'scheduled') refreshCron(); else refreshServices(); }

export function initServices() {
  initCron();
  const filterInput = document.getElementById('servicesFilter');
  if (filterInput) filterInput.addEventListener('input', () => { filter = filterInput.value; renderList(); });
  const bar = document.getElementById('servicesTabs');
  if (bar) bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.stab)));
  const btn = document.getElementById('btnServicesRefresh');
  if (btn) btn.addEventListener('click', refreshActive);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'services') refreshServices();
  });
}

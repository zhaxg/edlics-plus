// cron.mjs — Scheduled tab of the Services page: master/detail.
// Left = cron jobs + systemd timers; right = the task and its journal.
// Read-only.
import { api, escapeHtml, spinner, loadJournalInto } from './api.mjs';

let data = null;
let selected = null;   // { type:'job'|'timer', i }

function renderList() {
  const box = document.getElementById('cronList');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  const jobs = data.jobs || [];
  const timers = data.timers || [];
  if (!jobs.length && !timers.length) { box.innerHTML = '<div class="panel-placeholder">No scheduled tasks</div>'; return; }
  let html = '';
  if (jobs.length) {
    html += '<div class="split-group-title">cron jobs</div>';
    html += jobs.map((j, i) => `
      <div class="ilist-item list-item${isSel('job', i) ? ' selected' : ''}" data-type="job" data-i="${i}">
        <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(j.schedule)}</span>${j.user ? `<span class="ilist-meta">${escapeHtml(j.user)}</span>` : ''}</div>
        <div class="ilist-sub mono">${escapeHtml(j.command)}</div>
        <div class="ilist-sub">${escapeHtml(j.source)}</div>
      </div>`).join('');
  }
  if (timers.length) {
    html += '<div class="split-group-title">systemd timers</div>';
    html += timers.map((t, i) => `
      <div class="ilist-item list-item${isSel('timer', i) ? ' selected' : ''}" data-type="timer" data-i="${i}">
        <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(t.unit)}</span></div>
        ${t.activates ? `<div class="ilist-sub">activates ${escapeHtml(t.activates)}</div>` : ''}
      </div>`).join('');
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-type]').forEach(el => el.addEventListener('click', () => select(el.dataset.type, parseInt(el.dataset.i, 10))));
}

const isSel = (type, i) => selected && selected.type === type && selected.i === i;

function select(type, i) {
  selected = { type, i };
  renderList();
  const pane = document.getElementById('cronDetail');
  if (!pane || !data) return;

  if (type === 'job') {
    const j = data.jobs[i];
    pane.innerHTML = `
      <div class="detail-head"><span class="detail-title mono">${escapeHtml(j.schedule)}</span>
        <span class="ilist-meta">${escapeHtml(j.user || '')}</span></div>
      <div class="ilist-fields">
        <div class="ilist-field"><span class="ilist-k">command</span><span class="ilist-v">${escapeHtml(j.command)}</span></div>
        <div class="ilist-field"><span class="ilist-k">source</span><span class="ilist-v">${escapeHtml(j.source)}</span></div>
      </div>
      <div class="detail-section-title">Logs <span class="muted">(${escapeHtml(data.daemon || 'cron')})</span></div>
      <pre class="logs" id="cronLogs"></pre>`;
    if (data.daemon) loadJournalInto('cronLogs', data.daemon);
    else document.getElementById('cronLogs').textContent = 'No cron daemon unit detected';
    return;
  }

  const t = data.timers[i];
  pane.innerHTML = `
    <div class="detail-head"><span class="detail-title mono">${escapeHtml(t.unit)}</span></div>
    <div class="ilist-fields">
      ${t.activates ? `<div class="ilist-field"><span class="ilist-k">activates</span><span class="ilist-v">${escapeHtml(t.activates)}</span></div>` : ''}
      ${t.next ? `<div class="ilist-field"><span class="ilist-k">next</span><span class="ilist-v">${escapeHtml(t.next)}</span></div>` : ''}
      ${t.last ? `<div class="ilist-field"><span class="ilist-k">last</span><span class="ilist-v">${escapeHtml(t.last)}</span></div>` : ''}
    </div>
    <div class="detail-section-title">Logs <span class="muted">(${escapeHtml(t.activates || t.unit)})</span></div>
    <pre class="logs" id="cronLogs"></pre>`;
  const target = t.activates || t.unit;
  if (/\.service$/.test(target)) loadJournalInto('cronLogs', target);
  else document.getElementById('cronLogs').textContent = 'No service to read logs from';
}

function render() { renderList(); }

export async function refreshCron() {
  try { data = await api('GET', '/api/sys/cron'); } catch { data = null; }
  render();
}

export function initCron() {
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'services') refreshCron();
  });
}

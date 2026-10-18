// cron.mjs — Scheduled tasks section (rendered inside the Services page):
// crontab jobs + systemd timers. Read-only.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;

function renderJobs(jobs) {
  if (!jobs.length) return '<div class="panel-placeholder">No cron jobs</div>';
  return '<div class="ilist">' + jobs.map(j => `
    <div class="ilist-item">
      <div class="ilist-head">
        <span class="ilist-title mono">${escapeHtml(j.schedule)}</span>
        ${j.user ? `<span class="ilist-meta">${escapeHtml(j.user)}</span>` : ''}
      </div>
      <div class="ilist-sub mono">${escapeHtml(j.command)}</div>
      <div class="ilist-sub">${escapeHtml(j.source)}</div>
    </div>`).join('') + '</div>';
}

function renderTimers(timers) {
  if (!timers.length) return '<div class="panel-placeholder">No timers</div>';
  return '<div class="ilist">' + timers.map(t => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(t.unit)}</span>${t.next ? `<span class="ilist-meta">${escapeHtml(t.next)}</span>` : ''}</div>
      ${t.activates ? `<div class="ilist-sub">activates ${escapeHtml(t.activates)}</div>` : ''}
    </div>`).join('') + '</div>';
}

function render() {
  const box = document.getElementById('cronContent');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  box.innerHTML =
    `<div class="ilist-sub" style="margin:2px 0 6px;">Cron jobs (${data.jobs.length})</div>` + renderJobs(data.jobs) +
    `<div class="ilist-sub" style="margin:16px 0 6px;">systemd timers (${data.timers.length})</div>` + renderTimers(data.timers);
}

export async function refreshCron() {
  try { data = await api('GET', '/api/sys/cron'); } catch { data = null; }
  render();
}

export function initCron() {
  const btn = document.getElementById('btnCronRefresh');
  if (btn) btn.addEventListener('click', refreshCron);
  // Scheduled tasks now live inside the Services page.
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'services') refreshCron();
  });
}

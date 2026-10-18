// cron.mjs — Scheduled tasks panel: crontab jobs + systemd timers (read-only).
import { api, escapeHtml } from './api.mjs';

let data = null;

function render() {
  const box = document.getElementById('cronContent');
  if (!box) return;
  if (!data) { box.innerHTML = '<div class="panel-placeholder">Loading…</div>'; return; }
  const { jobs, timers } = data;
  let html = '';
  html += `<div class="svc-desc" style="margin:2px 0;">Cron jobs (${jobs.length})</div>`;
  if (!jobs.length) html += '<div class="panel-placeholder">No cron jobs</div>';
  else html += '<div class="net-table">' + jobs.map(j =>
    `<div class="cron-row">
      <div class="cron-sched">${escapeHtml(j.schedule)}${j.user ? ' <span class="cron-user">' + escapeHtml(j.user) + '</span>' : ''}</div>
      <div class="cron-cmd" title="${escapeHtml(j.command)}">${escapeHtml(j.command)}</div>
      <div class="cron-src">${escapeHtml(j.source)}</div>
    </div>`).join('') + '</div>';

  html += `<div class="svc-desc" style="margin:10px 0 2px;">systemd timers (${timers.length})</div>`;
  if (!timers.length) html += '<div class="panel-placeholder">No timers</div>';
  else html += '<div class="net-table">' + timers.map(t =>
    `<div class="cron-row">
      <div class="cron-sched">${escapeHtml(t.unit)}</div>
      <div class="cron-src" title="${escapeHtml(t.activates || '')}">${escapeHtml(t.activates || '')}</div>
      <div class="cron-src">${escapeHtml(t.next || '')}</div>
    </div>`).join('') + '</div>';
  box.innerHTML = html;
}

export async function refreshCron() {
  try { data = await api('GET', '/api/sys/cron'); } catch { data = null; }
  render();
}

export function initCron() {
  const btn = document.getElementById('btnCronRefresh');
  if (btn) btn.addEventListener('click', refreshCron);
  document.querySelector('.act-btn[data-view="cron"]')?.addEventListener('click', () => setTimeout(refreshCron, 0));
}

// logs.mjs — system journal viewer (Services ▸ Logs tab).
// Facets: source (login/auth/security/kernel), time range, priority, keyword.
import { api, escapeHtml, spinner } from './api.mjs';

let source = 'all';
let since = 'today';
let level = '';
let q = '';
let debounce = null;

const PRIO = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const prioName = n => PRIO[n] || String(n);
const prioClass = n => (n <= 3 ? 'log-err' : n === 4 ? 'log-warn' : n === 5 ? 'log-notice' : '');

function render(lines) {
  const box = document.getElementById('logsList');
  const count = document.getElementById('logsCount');
  if (!box) return;
  if (count) count.textContent = lines.length ? `${lines.length} lines` : '';
  if (!lines.length) { box.innerHTML = '<div class="panel-placeholder">No log entries for this filter</div>'; return; }
  box.innerHTML = lines.map(l => {
    const t = new Date(l.ts).toLocaleString();
    return `<div class="log-line">
      <span class="log-ts">${escapeHtml(t)}</span>
      <span class="log-prio ${prioClass(l.priority)}">${escapeHtml(prioName(l.priority))}</span>
      <span class="log-msg">${escapeHtml(l.message)}</span>
    </div>`;
  }).join('');
}

export async function refreshLogs() {
  const box = document.getElementById('logsList');
  if (box) box.innerHTML = spinner('Loading…');
  const params = new URLSearchParams({ source, since, lines: '500' });
  if (level) params.set('level', level);
  if (q) params.set('q', q);
  try {
    const r = await api('GET', '/api/sys/journal?' + params.toString());
    if (r.error) { if (box) box.textContent = r.error; return; }
    render(r.lines || []);
  } catch (e) { if (box) box.textContent = 'Failed: ' + e.message; }
}

export function initLogs() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('logSource', 'change', e => { source = e.target.value; refreshLogs(); });
  on('logSince', 'change', e => { since = e.target.value; refreshLogs(); });
  on('logLevel', 'change', e => { level = e.target.value; refreshLogs(); });
  on('logQuery', 'input', e => {
    q = e.target.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(refreshLogs, 350);
  });
  on('btnLogsRefresh', 'click', refreshLogs);
}

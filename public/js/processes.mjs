// processes.mjs — top-style process table. Auto-refreshes while visible.
// Signalling (TERM/KILL/…) appears only when the server has --admin-write.
import { api, escapeHtml, toast, choiceDialog } from './api.mjs';
import { serverInfo } from './state.mjs';

let rows = [];
let total = 0;
let summary = { load: [], cores: 0 };
let sort = 'cpu';
let q = '';
let timer = null;
let visible = false;

function canWrite() { return !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly); }

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + u[i];
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function render() {
  const box = document.getElementById('procContent');
  if (!box) return;
  // Summary lives in the section header row, next to the filter.
  const sum = document.getElementById('procSummary');
  if (sum) sum.textContent = `${total} processes · load ${summary.load.join(' ')} · ${summary.cores} cores`;
  const cols = `<div class="proc-head">
      <span data-sort="pid" class="proc-col proc-pid">PID</span>
      <span class="proc-col proc-user">USER</span>
      <span data-sort="cpu" class="proc-col proc-num${sort === 'cpu' ? ' active' : ''}">CPU%</span>
      <span data-sort="mem" class="proc-col proc-num${sort === 'mem' ? ' active' : ''}">MEM%</span>
      <span class="proc-col proc-num">RSS</span>
      <span class="proc-col proc-st">S</span>
      <span class="proc-col proc-cmd">COMMAND</span>
      ${canWrite() ? '<span class="proc-col proc-act"></span>' : ''}
    </div>`;
  const body = rows.map(p => `<div class="proc-row" title="pid ${p.pid} · ppid ${p.ppid} · ${escapeHtml(p.stateLabel)} · cpu-time ${fmtTime(p.time)} · up ${fmtTime(p.elapsed)}">
      <span class="proc-col proc-pid">${p.pid}</span>
      <span class="proc-col proc-user">${escapeHtml(p.user)}</span>
      <span class="proc-col proc-num">${p.cpu.toFixed(1)}</span>
      <span class="proc-col proc-num">${p.mem.toFixed(1)}</span>
      <span class="proc-col proc-num">${fmtBytes(p.rss)}</span>
      <span class="proc-col proc-st proc-st-${escapeHtml(p.state)}">${escapeHtml(p.state)}</span>
      <span class="proc-col proc-cmd">${escapeHtml(p.cmd || p.name)}</span>
      ${canWrite() ? `<span class="proc-col proc-act"><button data-kill="${p.pid}" data-name="${escapeHtml(p.name)}" title="Signal ${escapeHtml(p.name)}">kill</button></span>` : ''}
    </div>`).join('');
  box.innerHTML = `<div class="proc-scroll">${cols}<div class="proc-table">${body || '<div class="panel-placeholder">No matches</div>'}</div></div>`;

  box.querySelectorAll('[data-sort]').forEach(el => el.addEventListener('click', () => { sort = el.dataset.sort; load(); }));
  box.querySelectorAll('[data-kill]').forEach(btn => btn.addEventListener('click', () => signalDialog(parseInt(btn.dataset.kill, 10), btn.dataset.name)));
}

async function signalDialog(pid, name) {
  const sig = await choiceDialog(`Signal PID ${pid}`, name || '', [
    { label: 'Terminate (TERM)', value: 'TERM' },
    { label: 'Kill (KILL)', value: 'KILL', danger: true },
    { label: 'HUP', value: 'HUP' },
    { label: 'INT', value: 'INT' },
    { label: 'STOP', value: 'STOP' },
    { label: 'CONT', value: 'CONT' },
  ]);
  if (!sig) return;
  try {
    const r = await api('POST', '/api/sys/processes/kill', { pid, signal: sig });
    if (r.error) toast(r.error, true); else toast(`${sig} → ${name || pid}`);
  } catch (e) { toast('signal failed: ' + e.message, true); }
  load();
}

async function load() {
  try {
    const d = await api('GET', `/api/sys/processes?sort=${sort}&limit=120${q ? '&q=' + encodeURIComponent(q) : ''}`);
    if (d.error) { return; }
    rows = d.processes || [];
    total = d.total || 0;
    summary = { load: d.load || [], cores: d.cores || 0 };
    render();
  } catch { /* transient */ }
}

function startTimer() { if (!timer) timer = setInterval(load, 2000); }
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

export function refreshProcesses() { load(); }

export function initProcesses() {
  const search = document.getElementById('procFilter');
  if (search) search.addEventListener('input', () => { q = search.value.toLowerCase(); load(); });
  const btn = document.getElementById('btnProcessesRefresh');
  if (btn) btn.addEventListener('click', load);
  document.querySelector('.act-btn[data-view="processes"]')?.addEventListener('click', () => setTimeout(load, 0));
  // Only poll while the panel is actually visible. The table now lives inside
  // the Dashboard (overview) page.
  document.addEventListener('view-changed', e => {
    visible = e.detail && e.detail.view === 'overview';
    if (visible) { load(); startTimer(); } else stopTimer();
  });
}

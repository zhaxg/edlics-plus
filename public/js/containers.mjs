// containers.mjs — Docker board with tab switching (Containers | Compose).
//
// Tab-driven so future resources (Images, Networks, Volumes…) slot in by
// adding a tab + a render function + a backend endpoint — see TABS below.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;
let tab = 'containers';
const openLogs = new Set();

// Tab registry: label + count accessor + renderer. Extend here for Images etc.
const TABS = {
  containers: {
    label: 'Containers',
    count: d => (d.containers || []).length,
    render: renderContainers,
  },
  compose: {
    label: 'Compose',
    count: d => (d.compose || []).length,
    render: renderCompose,
  },
};

function stateDot(state) {
  const cls = state === 'running' ? 'ok' : state === 'exited' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

function renderContainers(d) {
  if (!d.containers.length) return '<div class="panel-placeholder">No containers</div>';
  return '<div class="ilist">' + d.containers.map(c => {
    const open = openLogs.has(c.id);
    return `<div class="ilist-item">
      <div class="ilist-head">${stateDot(c.state)}
        <span class="ilist-title">${escapeHtml(c.name)}</span>
        <span class="ilist-meta">${escapeHtml(c.state)}</span>
        <button class="svc-logs-btn" data-clogs="${escapeHtml(c.id)}">log</button>
      </div>
      <div class="ilist-sub mono">${escapeHtml(c.image)}</div>
      ${c.ports ? `<div class="ilist-sub">${escapeHtml(c.ports)}</div>` : ''}
      <pre class="svc-logs${open ? '' : ' hidden'}" data-clogbox="${escapeHtml(c.id)}"></pre>
    </div>`;
  }).join('') + '</div>';
}

function renderCompose(d) {
  if (!d.compose.length) return '<div class="panel-placeholder">No compose projects</div>';
  return '<div class="ilist">' + d.compose.map(p => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">${escapeHtml(p.name)}</span><span class="ilist-meta">${escapeHtml(p.status)}</span></div>
      <div class="ilist-sub mono">${escapeHtml(p.configFiles)}</div>
    </div>`).join('') + '</div>';
}

function renderTabs() {
  const bar = document.getElementById('containerTabs');
  if (!bar) return;
  bar.querySelectorAll('button').forEach(b => {
    const t = TABS[b.dataset.ctab];
    b.textContent = t && data ? `${t.label} (${t.count(data)})` : (t ? t.label : b.dataset.ctab);
    b.classList.toggle('active', b.dataset.ctab === tab);
  });
}

function render() {
  const box = document.getElementById('containersContent');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  if (!data.available) { box.innerHTML = '<div class="panel-placeholder">Docker is not available</div>'; return; }
  const t = TABS[tab] || TABS.containers;
  box.innerHTML = t.render(data);
  box.querySelectorAll('.svc-logs-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleLogs(btn.dataset.clogs));
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

export async function refreshContainers() {
  try { data = await api('GET', '/api/sys/containers'); } catch { data = null; }
  renderTabs();
  render();
}

export function initContainers() {
  const bar = document.getElementById('containerTabs');
  if (bar) {
    bar.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        tab = btn.dataset.ctab;
        renderTabs();
        render();
      });
    });
  }
  const btn = document.getElementById('btnContainersRefresh');
  if (btn) btn.addEventListener('click', refreshContainers);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'containers') refreshContainers();
  });
}

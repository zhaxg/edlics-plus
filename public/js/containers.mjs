// containers.mjs — Docker containers + compose projects (read-only).
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;
const openLogs = new Set();

function stateDot(state) {
  const cls = state === 'running' ? 'ok' : state === 'exited' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

function render() {
  const box = document.getElementById('containersContent');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  if (!data.available) { box.innerHTML = '<div class="panel-placeholder">Docker is not available</div>'; return; }

  const composeHtml = data.compose.length
    ? `<div class="svc-desc" style="margin:2px 0;">Compose projects (${data.compose.length})</div>
       <div class="net-table">${data.compose.map(p =>
        `<div class="net-row"><span class="net-dst">${escapeHtml(p.name)}</span><span class="net-proc" title="${escapeHtml(p.configFiles)}">${escapeHtml(p.status)}</span></div>`
      ).join('')}</div>`
    : '';

  const listHtml = data.containers.length
    ? data.containers.map(c => {
        const open = openLogs.has(c.id);
        return `<div class="service-row">
          <div class="svc-head">${stateDot(c.state)}
            <span class="svc-name" title="${escapeHtml(c.id)}">${escapeHtml(c.name)}</span>
            <span class="svc-sub">${escapeHtml(c.state)}</span>
            <button class="svc-logs-btn" data-clogs="${escapeHtml(c.id)}">log</button>
          </div>
          <div class="svc-desc" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}${c.ports ? ' · ' + escapeHtml(c.ports) : ''}</div>
          <pre class="svc-logs${open ? '' : ' hidden'}" data-clogbox="${escapeHtml(c.id)}"></pre>
        </div>`;
      }).join('')
    : '<div class="panel-placeholder">No containers</div>';

  box.innerHTML = composeHtml + `<div class="svc-desc" style="margin:10px 0 2px;">Containers (${data.containers.length})</div>` + listHtml;

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
  render();
}

export function initContainers() {
  const btn = document.getElementById('btnContainersRefresh');
  if (btn) btn.addEventListener('click', refreshContainers);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'containers') refreshContainers();
  });
}

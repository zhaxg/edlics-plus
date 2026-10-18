// users.mjs — Users / Groups / Sessions panel (read-only).
import { api, escapeHtml } from './api.mjs';

let tab = 'users';
let data = null;
let q = '';

function renderUsers() {
  const rows = data.users.filter(u => !q || u.name.toLowerCase().includes(q));
  return '<div class="net-table">' + rows.map(u =>
    `<div class="net-row">
      <span class="net-dst">${escapeHtml(u.name)}</span>
      <span class="net-via">${u.uid}:${u.gid}</span>
      <span class="net-dev" title="${escapeHtml(u.shell)}">${escapeHtml(u.group)}</span>
      <span class="net-proc" title="${escapeHtml(u.home)}">${u.system ? 'system' : escapeHtml(u.gecos || u.home)}</span>
    </div>`).join('') + '</div>';
}

function renderGroups() {
  const rows = data.groups.filter(g => !q || g.name.toLowerCase().includes(q));
  return '<div class="net-table">' + rows.map(g =>
    `<div class="net-row">
      <span class="net-dst">${escapeHtml(g.name)}</span>
      <span class="net-via">${g.gid}</span>
      <span class="net-proc" title="${escapeHtml(g.members.join(', '))}">${escapeHtml(g.members.join(', ') || '—')}</span>
    </div>`).join('') + '</div>';
}

function renderSessions() {
  if (!data.sessions.length) return '<div class="panel-placeholder">No interactive sessions</div>';
  return '<div class="net-table">' + data.sessions.map(s =>
    `<div class="net-row">
      <span class="net-dst">${escapeHtml(s.user)}</span>
      <span class="net-via">${escapeHtml(s.tty)}</span>
      <span class="net-proc" title="${escapeHtml(s.since)}">${escapeHtml(s.from || s.since)}</span>
    </div>`).join('') + '</div>';
}

function render() {
  const box = document.getElementById('usersContent');
  if (!box) return;
  if (!data) { box.innerHTML = '<div class="panel-placeholder">Loading…</div>'; return; }
  const c = data.counts;
  const head = `<div class="net-card"><div class="svc-desc">${c.human} human · ${c.system} system · ${c.groups} groups · ${data.sessions.length} sessions</div></div>`;
  box.innerHTML = head + (tab === 'users' ? renderUsers() : tab === 'groups' ? renderGroups() : renderSessions());
}

export async function refreshUsers() {
  try { data = await api('GET', '/api/sys/users'); } catch { data = null; }
  render();
}

export function initUsers() {
  const tabsEl = document.getElementById('usersTabs');
  if (tabsEl) {
    tabsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        tab = btn.dataset.utab;
        tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });
  }
  const search = document.getElementById('usersFilter');
  if (search) search.addEventListener('input', () => { q = search.value.toLowerCase(); render(); });
  const btn = document.getElementById('btnUsersRefresh');
  if (btn) btn.addEventListener('click', refreshUsers);
  document.querySelector('.act-btn[data-view="users"]')?.addEventListener('click', () => setTimeout(refreshUsers, 0));
}

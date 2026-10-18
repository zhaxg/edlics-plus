// users.mjs — Users / Groups / Sessions panel (read-only).
import { api, escapeHtml, spinner } from './api.mjs';

let tab = 'users';
let data = null;
let q = '';

function renderUsers() {
  const rows = data.users.filter(u => !q || u.name.toLowerCase().includes(q));
  if (!rows.length) return '<div class="panel-placeholder">No matches</div>';
  return '<div class="ilist">' + rows.map(u => `
    <div class="ilist-item">
      <div class="ilist-head">
        <span class="ilist-title">${escapeHtml(u.name)}</span>
        <span class="ilist-meta">uid ${u.uid} · gid ${u.gid}${u.system ? ' · system' : ''}</span>
      </div>
      <div class="ilist-fields">
        <div class="ilist-field"><span class="ilist-k">group</span><span class="ilist-v">${escapeHtml(u.group)}${u.groups.length ? ' + ' + escapeHtml(u.groups.join(', ')) : ''}</span></div>
        <div class="ilist-field"><span class="ilist-k">home</span><span class="ilist-v">${escapeHtml(u.home)}</span></div>
        <div class="ilist-field"><span class="ilist-k">shell</span><span class="ilist-v">${escapeHtml(u.shell)}</span></div>
      </div>
    </div>`).join('') + '</div>';
}

function renderGroups() {
  const rows = data.groups.filter(g => !q || g.name.toLowerCase().includes(q));
  if (!rows.length) return '<div class="panel-placeholder">No matches</div>';
  return '<div class="ilist">' + rows.map(g => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">${escapeHtml(g.name)}</span><span class="ilist-meta">gid ${g.gid}</span></div>
      <div class="ilist-sub">${g.members.length ? escapeHtml(g.members.join(', ')) : 'no members'}</div>
    </div>`).join('') + '</div>';
}

function renderSessions() {
  if (!data.sessions.length) return '<div class="panel-placeholder">No interactive sessions</div>';
  return '<div class="ilist">' + data.sessions.map(s => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">${escapeHtml(s.user)}</span><span class="ilist-meta">${escapeHtml(s.tty)}</span></div>
      <div class="ilist-sub">${escapeHtml(s.from || 'local')}${s.since ? ' · ' + escapeHtml(s.since) : ''}</div>
    </div>`).join('') + '</div>';
}

function render() {
  const box = document.getElementById('usersContent');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
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
  // The Access page hosts both accounts and scheduled tasks.
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'access') refreshUsers();
  });
}

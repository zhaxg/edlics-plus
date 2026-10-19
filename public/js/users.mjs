// users.mjs — Access page as a 3-column board: Users / Groups / Sessions.
// Each column is a card with its own scrollable list. Read-only.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;
let q = '';
let showSystem = false;

// A "system account" is one that can't be logged into — its shell is nologin,
// false or sync. These live in /etc/passwd but are not real users (bin, daemon,
// www-data, …), so they're hidden by default.
const nonLogin = s => /nologin|false$/i.test(String(s || '')) || /(^|\/)(sync)$/.test(String(s || ''));

function fill(bodyId, countId, items) {
  const body = document.getElementById(bodyId);
  const count = document.getElementById(countId);
  if (count) count.textContent = items.length ? String(items.length) : '';
  if (!body) return;
  body.innerHTML = items.length
    ? `<div class="ilist">${items.join('')}</div>`
    : '<div class="panel-placeholder">No matches</div>';
}

function userItems() {
  return data.users
    .filter(u => !q || u.name.toLowerCase().includes(q))
    .filter(u => showSystem || !nonLogin(u.shell))
    .map(u => `<div class="ilist-item">
      <div class="ilist-head">
        <span class="ilist-title">${escapeHtml(u.name)}</span>
        <span class="ilist-meta">${u.uid}${u.system ? ' · sys' : ''}</span>
      </div>
      <div class="ilist-fields">
        <div class="ilist-field"><span class="ilist-k">gid</span><span class="ilist-v">${u.gid} ${escapeHtml(u.group)}${u.groups.length ? ' + ' + escapeHtml(u.groups.join(', ')) : ''}</span></div>
        <div class="ilist-field"><span class="ilist-k">home</span><span class="ilist-v">${escapeHtml(u.home)}</span></div>
        <div class="ilist-field"><span class="ilist-k">shell</span><span class="ilist-v">${escapeHtml(u.shell)}</span></div>
      </div>
    </div>`);
}

function groupItems() {
  return data.groups
    .filter(g => !q || g.name.toLowerCase().includes(q))
    .map(g => `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">${escapeHtml(g.name)}</span><span class="ilist-meta">gid ${g.gid}</span></div>
      <div class="ilist-sub">${g.members.length ? escapeHtml(g.members.join(', ')) : 'no members'}</div>
    </div>`);
}

function sessionItems() {
  return data.sessions
    .filter(s => !q || s.user.toLowerCase().includes(q))
    .map(s => `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">${escapeHtml(s.user)}</span><span class="ilist-meta">${escapeHtml(s.tty)}</span></div>
      <div class="ilist-sub">${escapeHtml(s.from || 'local')}${s.since ? ' · ' + escapeHtml(s.since) : ''}</div>
    </div>`);
}

function render() {
  if (!data) {
    ['accUsers', 'accGroups', 'accSessions'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = spinner('Loading…');
    });
    return;
  }
  // Update the "system accounts" toggle with the hidden count.
  const toggle = document.getElementById('accUsersToggle');
  if (toggle) {
    const sysCount = data.users.filter(u => nonLogin(u.shell)).length;
    toggle.textContent = `system (${sysCount})`;
    toggle.classList.toggle('active', showSystem);
  }
  fill('accUsers', 'accUsersCount', userItems());
  fill('accGroups', 'accGroupsCount', groupItems());
  fill('accSessions', 'accSessionsCount', sessionItems());
}

export async function refreshUsers() {
  try { data = await api('GET', '/api/sys/users'); } catch { data = null; }
  render();
}

export function initUsers() {
  const search = document.getElementById('usersFilter');
  if (search) search.addEventListener('input', () => { q = search.value.toLowerCase().trim(); render(); });
  const toggle = document.getElementById('accUsersToggle');
  if (toggle) toggle.addEventListener('click', () => { showSystem = !showSystem; render(); });
  const btn = document.getElementById('btnUsersRefresh');
  if (btn) btn.addEventListener('click', refreshUsers);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'access') refreshUsers();
  });
}

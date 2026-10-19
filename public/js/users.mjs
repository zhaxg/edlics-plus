// users.mjs — Users view for the System page: login-capable accounts + active
// sessions (who). Read-only. (lastlog/last are not installed on this host, so
// last-login times aren't shown.)
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;
let q = '';
let showSystem = false;

// A "system account" can't be logged into — shell is nologin/false/sync.
const nonLogin = s => /nologin|false$/i.test(String(s || '')) || /(^|\/)(sync)$/.test(String(s || ''));

function userItem(u) {
  return `<div class="ilist-item">
    <div class="ilist-head">
      <span class="ilist-title">${escapeHtml(u.name)}</span>
      <span class="ilist-meta">${u.uid}${u.system ? ' · sys' : ''}</span>
    </div>
    <div class="ilist-fields">
      <div class="ilist-field"><span class="ilist-k">group</span><span class="ilist-v">${escapeHtml(u.group)} (${u.gid})</span></div>
      ${u.groups.length ? `<div class="ilist-field"><span class="ilist-k">also in</span><span class="ilist-v">${escapeHtml(u.groups.join(', '))}</span></div>` : ''}
      <div class="ilist-field"><span class="ilist-k">home</span><span class="ilist-v">${escapeHtml(u.home)}</span></div>
      <div class="ilist-field"><span class="ilist-k">shell</span><span class="ilist-v">${escapeHtml(u.shell)}</span></div>
    </div>
  </div>`;
}

function sessionItem(s) {
  return `<div class="ilist-item">
    <div class="ilist-head"><span class="ilist-title">${escapeHtml(s.user)}</span><span class="ilist-meta">${escapeHtml(s.tty)}</span></div>
    <div class="ilist-sub">${escapeHtml(s.from || 'local')}${s.since ? ' · ' + escapeHtml(s.since) : ''}</div>
  </div>`;
}

function render() {
  const box = document.getElementById('usersBoard');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  const users = data.users
    .filter(u => !q || u.name.toLowerCase().includes(q))
    .filter(u => showSystem || !nonLogin(u.shell));
  const sessions = data.sessions || [];
  const sysCount = data.users.filter(u => nonLogin(u.shell)).length;

  box.innerHTML = `<div class="board-cols">
    <section class="net-col">
      <header class="net-col-head"><h3>Login users</h3>
        <button id="accUsersToggle" class="chip-btn${showSystem ? ' active' : ''}" title="Include system accounts (no login shell)">system (${sysCount})</button>
        <span class="net-count">${users.length}</span></header>
      <div class="net-col-body">${users.length ? `<div class="ilist">${users.map(userItem).join('')}</div>` : '<div class="panel-placeholder">No login users</div>'}</div>
    </section>
    <section class="net-col">
      <header class="net-col-head"><h3>Sessions</h3><span class="net-count">${sessions.length}</span></header>
      <div class="net-col-body">${sessions.length ? `<div class="ilist">${sessions.map(sessionItem).join('')}</div>` : '<div class="panel-placeholder">No active sessions</div>'}</div>
    </section>
  </div>`;
  const t = box.querySelector('#accUsersToggle');
  if (t) t.addEventListener('click', () => { showSystem = !showSystem; render(); });
}

export async function refreshUsers() {
  try { data = await api('GET', '/api/sys/users'); } catch { data = null; }
  render();
}

export function initUsers() { /* refreshed on tab activation by services.mjs */ }

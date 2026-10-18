// network.mjs — Network panel: interfaces, routes, DNS, listening sockets and
// firewall (nftables) summary. Read-only; all data comes from /api/sys/network*.
import { api, escapeHtml, spinner } from './api.mjs';

let tab = 'ifaces';
let netData = null;      // { interfaces, routes, dns }
let sockets = null;      // cached lazily
let firewall = null;

function stateDot(state) {
  const cls = state === 'UP' ? 'ok' : state === 'DOWN' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

function renderIfaces() {
  const n = netData;
  if (!n) return spinner('Loading…');
  let html = '';
  if (!n.interfaces.length) {
    html = '<div class="panel-placeholder">No interfaces</div>';
  } else {
    html = '<div class="ilist">' + n.interfaces.map(i => {
      const addrs = (i.addresses || []);
      const v4 = addrs.filter(a => a.family === 'inet');
      const v6 = addrs.filter(a => a.family === 'inet6');
      // IPv4 first, then IPv6 — one address per line.
      const addrHtml = [...v4, ...v6]
        .map(a => `<div class="ilist-addr">${escapeHtml(a.address)}/${a.prefixlen}</div>`).join('');
      return `<div class="ilist-item">
        <div class="ilist-head">${stateDot(i.state)}<span class="ilist-title">${escapeHtml(i.name)}</span>
          <span class="ilist-meta">${escapeHtml(i.state || '')}${i.mtu ? ' · MTU ' + i.mtu : ''}</span></div>
        <div class="ilist-addrs">${addrHtml || '<div class="ilist-addr muted">no address</div>'}</div>
        <div class="ilist-sub">MAC ${escapeHtml(i.mac || '—')}</div>
      </div>`;
    }).join('') + '</div>';
  }
  if (n.dns && n.dns.nameservers.length) {
    html += `<div class="ilist" style="margin-top:10px;"><div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">DNS</span></div>
      <div class="ilist-addrs">${n.dns.nameservers.map(s => `<div class="ilist-addr">${escapeHtml(s)}</div>`).join('')}</div>
      ${n.dns.search.length ? `<div class="ilist-sub">search: ${escapeHtml(n.dns.search.join(' '))}</div>` : ''}
    </div></div>`;
  }
  return html;
}

function renderRoutes() {
  const n = netData;
  if (!n) return spinner('Loading…');
  if (!n.routes.length) return '<div class="panel-placeholder">No routes</div>';
  return '<div class="ilist">' + n.routes.map(r => {
    const fields = [
      r.gateway ? ['via', r.gateway] : null,
      r.dev ? ['dev', r.dev] : null,
      r.prefsrc ? ['src', r.prefsrc] : null,
      r.metric != null ? ['metric', String(r.metric)] : null,
    ].filter(Boolean).map(([k, v]) =>
      `<div class="ilist-field"><span class="ilist-k">${k}</span><span class="ilist-v">${escapeHtml(v)}</span></div>`).join('');
    return `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(r.dst)}</span>
        <span class="ilist-meta">${escapeHtml(r.family || 'inet')}${r.protocol ? ' · ' + escapeHtml(r.protocol) : ''}</span></div>
      ${fields ? `<div class="ilist-fields">${fields}</div>` : ''}
    </div>`;
  }).join('') + '</div>';
}

function renderSockets() {
  if (sockets === null) return spinner('Loading…');
  if (!sockets.length) return '<div class="panel-placeholder">No listening sockets</div>';
  return '<div class="ilist">' + sockets.map(s => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(s.local)}</span>
        <span class="ilist-meta">${escapeHtml(s.proto)} · ${escapeHtml(s.state)}</span></div>
      ${s.process ? `<div class="ilist-sub mono">${escapeHtml(s.process)}</div>` : ''}
    </div>`).join('') + '</div>';
}

function renderFirewall() {
  if (firewall === null) return spinner('Loading…');
  const f = firewall;
  if (!f.available) return '<div class="panel-placeholder">nftables not available</div>';
  if (!f.tables) return '<div class="panel-placeholder">No nftables tables</div>';
  const summary = `<div class="ilist-item" style="margin-bottom:10px;"><div class="ilist-head">
      <span class="ilist-title">nftables</span>
      <span class="ilist-meta">${f.tables} tables · ${f.chains} chains · ${f.rules} rules</span></div></div>`;
  return summary + '<div class="ilist">' + f.list.map(t => `
    <div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(t.name)}</span>
        <span class="ilist-meta">${escapeHtml(t.family)} · ${t.chains} chains</span></div>
    </div>`).join('') + '</div>';
}

function render() {
  const box = document.getElementById('netContent');
  if (!box) return;
  box.innerHTML = tab === 'ifaces' ? renderIfaces()
    : tab === 'routes' ? renderRoutes()
    : tab === 'sockets' ? renderSockets()
    : renderFirewall();
}

async function ensureSection(name) {
  if (name === 'sockets' && sockets === null) {
    try { sockets = (await api('GET', '/api/sys/network/sockets')).sockets || []; } catch { sockets = []; }
  }
  if (name === 'fw' && firewall === null) {
    try { firewall = (await api('GET', '/api/sys/network/firewall')).firewall || { available: false }; } catch { firewall = { available: false }; }
  }
}

export async function refreshNetwork() {
  const box = document.getElementById('netContent');
  if (box) box.innerHTML = spinner('Loading…');
  try { netData = await api('GET', '/api/sys/network'); } catch { netData = { interfaces: [], routes: [], dns: { nameservers: [], search: [] } }; }
  if (tab === 'sockets' || tab === 'fw') await ensureSection(tab);
  render();
}

export function initNetwork() {
  const tabsEl = document.getElementById('netTabs');
  if (tabsEl) {
    tabsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        tab = btn.dataset.ntab;
        tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        await ensureSection(tab);
        render();
      });
    });
  }
  const btn = document.getElementById('btnNetworkRefresh');
  if (btn) btn.addEventListener('click', refreshNetwork);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'network') refreshNetwork();
  });
}

// network.mjs — Network panel: interfaces, routes, DNS, listening sockets and
// firewall (nftables) summary. Read-only; all data comes from /api/sys/network*.
import { api, escapeHtml } from './api.mjs';

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
  if (!n) return '<div class="panel-placeholder">Loading…</div>';
  if (!n.interfaces.length) return '<div class="panel-placeholder">No interfaces</div>';
  let html = '';
  for (const i of n.interfaces) {
    const addrs = [...i.v4, ...i.v6].map(a => `<span class="net-chip">${escapeHtml(a)}</span>`).join('');
    html += `<div class="net-card">
      <div class="net-iface-head">${stateDot(i.state)}<span class="svc-name">${escapeHtml(i.name)}</span><span class="svc-sub">${escapeHtml(i.state || '')}</span></div>
      <div class="net-addrs">${addrs || '<span class="svc-desc">no address</span>'}</div>
      <div class="svc-desc">MAC ${escapeHtml(i.mac || '—')} · MTU ${i.mtu || '—'}</div>
    </div>`;
  }
  if (n.dns && n.dns.nameservers.length) {
    html += `<div class="net-card"><div class="svc-desc" style="margin:0 0 3px;">DNS</div>
      <div class="net-addrs">${n.dns.nameservers.map(s => `<span class="net-chip">${escapeHtml(s)}</span>`).join('')}</div>
      ${n.dns.search.length ? `<div class="svc-desc">search: ${escapeHtml(n.dns.search.join(' '))}</div>` : ''}</div>`;
  }
  return html;
}

function renderRoutes() {
  const n = netData;
  if (!n) return '<div class="panel-placeholder">Loading…</div>';
  if (!n.routes.length) return '<div class="panel-placeholder">No routes</div>';
  return '<div class="net-table">' + n.routes.map(r =>
    `<div class="net-row"><span class="net-dst">${escapeHtml(r.dst)}</span>
      <span class="net-via">${escapeHtml(r.gateway || '')}</span>
      <span class="net-dev">${escapeHtml(r.dev || '')}${r.metric != null ? ' m' + r.metric : ''}</span></div>`
  ).join('') + '</div>';
}

function renderSockets() {
  if (sockets === null) return '<div class="panel-placeholder">Loading…</div>';
  if (!sockets.length) return '<div class="panel-placeholder">No listening sockets</div>';
  return '<div class="net-table">' + sockets.map(s =>
    `<div class="net-row"><span class="net-proto">${escapeHtml(s.proto)}</span>
      <span class="net-local">${escapeHtml(s.local)}</span>
      <span class="net-proc" title="${escapeHtml(s.process)}">${escapeHtml(s.process || '')}</span></div>`
  ).join('') + '</div>';
}

function renderFirewall() {
  if (firewall === null) return '<div class="panel-placeholder">Loading…</div>';
  const f = firewall;
  if (!f.available) return '<div class="panel-placeholder">nftables not available</div>';
  if (!f.tables) return '<div class="panel-placeholder">No nftables tables</div>';
  return `<div class="net-card"><div class="svc-desc">${f.tables} tables · ${f.chains} chains · ${f.rules} rules</div></div>` +
    '<div class="net-table">' + f.list.map(t =>
      `<div class="net-row"><span class="net-dst">${escapeHtml(t.name)}</span><span class="net-via">${escapeHtml(t.family)}</span><span class="net-dev">${t.chains} chains</span></div>`
    ).join('') + '</div>';
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
  if (box) box.innerHTML = '<div class="panel-placeholder">Loading…</div>';
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
  document.querySelector('.act-btn[data-view="network"]')?.addEventListener('click', () => setTimeout(refreshNetwork, 0));
}

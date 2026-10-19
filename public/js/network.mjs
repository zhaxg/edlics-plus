// network.mjs — Network as a 4-column board (Interfaces / Routes / Sockets /
// Firewall). Each column is a card with its own scrollable item list.
// Read-only; data from /api/sys/network{,/sockets,/firewall}.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;      // { interfaces, routes, dns }
let sockets = null;
let firewall = null;

function dot(state) {
  const cls = state === 'UP' ? 'ok' : state === 'DOWN' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

/** Render a list of item-html strings into a column body, with a count. */
function fill(bodyId, countId, items) {
  const body = document.getElementById(bodyId);
  const count = document.getElementById(countId);
  if (count) count.textContent = items.length ? String(items.length) : '';
  if (!body) return;
  body.innerHTML = items.length ? `<div class="ilist">${items.join('')}</div>`
    : '<div class="panel-placeholder">No data</div>';
}

// --- item builders ---------------------------------------------------------

function fmtLft(sec) {
  if (sec == null) return '';
  if (sec >= 86400) return Math.round(sec / 86400) + 'd';
  if (sec >= 3600) return Math.round(sec / 3600) + 'h';
  if (sec >= 60) return Math.round(sec / 60) + 'm';
  return sec + 's';
}

function ifaceItems(n) {
  const items = (n.interfaces || []).map(i => {
    const addrAll = (i.addresses || []);
    const v4 = addrAll.filter(a => a.family === 'inet');
    const v6 = addrAll.filter(a => a.family === 'inet6');
    // IPv4 first, then IPv6 — one address per line, each tagged with its kind.
    const addrHtml = [...v4, ...v6].map(a => {
      const tip = a.kind === 'link-local' ? 'link-local (fe80::)'
        : `${a.kind}${a.preferred != null ? ' · preferred ' + fmtLft(a.preferred) : ''}${a.valid != null ? ' · valid ' + fmtLft(a.valid) : ''}`;
      return `<div class="ilist-addr" title="${escapeHtml(tip)}">
        <span>${escapeHtml(a.address)}/${a.prefixlen}</span>
        <span class="addr-tag addr-${String(a.kind).replace(/-/g, '')}">${escapeHtml(a.kind)}</span>
      </div>`;
    }).join('');
    const globals = addrAll.filter(a => a.family === 'inet6' && a.scope === 'global').length;
    const note = globals > 2
      ? `<div class="ilist-sub">${globals} global v6 addresses — normal for SLAAC with rolling/multiple prefixes; older ones expire (see tooltips)</div>`
      : '';
    return `<div class="ilist-item">
      <div class="ilist-head">${dot(i.state)}<span class="ilist-title">${escapeHtml(i.name)}</span>
        <span class="ilist-meta">${escapeHtml(i.state || '')}${i.mtu ? ' · MTU ' + i.mtu : ''}</span></div>
      <div class="ilist-addrs">${addrHtml || '<div class="ilist-addr muted">no address</div>'}</div>
      ${note}
      <div class="ilist-sub">MAC ${escapeHtml(i.mac || '—')}</div>
    </div>`;
  });
  if (n.dns && n.dns.nameservers.length) {
    items.push(`<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title">DNS</span></div>
      <div class="ilist-addrs">${n.dns.nameservers.map(s => `<div class="ilist-addr">${escapeHtml(s)}</div>`).join('')}</div>
      ${n.dns.search.length ? `<div class="ilist-sub">search: ${escapeHtml(n.dns.search.join(' '))}</div>` : ''}
    </div>`);
  }
  return items;
}

function routeItems(n) {
  return (n.routes || []).map(r => {
    const fields = [
      r.gateway ? ['via', r.gateway] : null,
      r.dev ? ['dev', r.dev] : null,
      r.prefsrc ? ['src', r.prefsrc] : null,
      r.metric != null ? ['metric', String(r.metric)] : null,
    ].filter(Boolean).map(([k, v]) =>
      `<div class="ilist-field"><span class="ilist-k">${k}</span><span class="ilist-v">${escapeHtml(v)}</span></div>`).join('');
    return `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(r.dst)}</span>
        <span class="ilist-meta">${r.family === 'inet6' ? 'v6' : 'v4'}</span></div>
      ${fields ? `<div class="ilist-fields">${fields}</div>` : ''}
    </div>`;
  });
}

function socketItems() {
  if (sockets === null) return null;
  return sockets.map(s => `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(s.local)}</span>
        <span class="ilist-meta">${escapeHtml(s.proto)}</span></div>
      ${s.process ? `<div class="ilist-sub mono">${escapeHtml(s.process)}</div>` : ''}
    </div>`);
}

function firewallItems() {
  if (firewall === null) return null;
  const f = firewall;
  if (!f.available || !f.tables) return [];
  const out = [`<div class="ilist-item"><div class="ilist-head">
      <span class="ilist-title">nftables</span>
      <span class="ilist-meta">${f.chains} chains · ${f.rules} rules</span></div></div>`];
  for (const t of f.list) {
    out.push(`<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(t.name)}</span>
        <span class="ilist-meta">${escapeHtml(t.family)} · ${t.chains}</span></div></div>`);
  }
  return out;
}

// --- render ----------------------------------------------------------------

function render() {
  const n = data || { interfaces: [], routes: [], dns: { nameservers: [], search: [] } };
  fill('netIfaces', 'netIfCount', ifaceItems(n));
  fill('netRoutes', 'netRoutesCount', routeItems(n));
  fill('netSockets', 'netSocketsCount', socketItems() || []);
  fill('netFw', 'netFwCount', firewallItems() || []);
}

export async function refreshNetwork() {
  data = null; sockets = null; firewall = null;
  document.getElementById('netIfaces') && (document.getElementById('netIfaces').innerHTML = spinner('Loading…'));
  const [net, sock, fw] = await Promise.all([
    api('GET', '/api/sys/network').catch(() => ({ interfaces: [], routes: [], dns: { nameservers: [], search: [] } })),
    api('GET', '/api/sys/network/sockets').catch(() => ({ sockets: [] })),
    api('GET', '/api/sys/network/firewall').catch(() => ({ firewall: { available: false, tables: 0, chains: 0, rules: 0, list: [] } })),
  ]);
  data = net;
  sockets = sock.sockets || [];
  firewall = fw.firewall || { available: false, tables: 0, chains: 0, rules: 0, list: [] };
  render();
}

export function initNetwork() {
  const btn = document.getElementById('btnNetworkRefresh');
  if (btn) btn.addEventListener('click', refreshNetwork);
  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'network') refreshNetwork();
  });
}

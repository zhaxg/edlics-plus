// network.mjs — network views for the System page tabs: Interfaces / Routes /
// Ports / Firewall. Read-only; data from /api/sys/network{,/sockets,/firewall}.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;      // { interfaces, routes, dns }
let sockets = null;
let firewall = null;

function dot(state) {
  const cls = state === 'UP' ? 'ok' : state === 'DOWN' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

function board(elId, items, empty) {
  const b = document.getElementById(elId);
  if (!b) return;
  b.innerHTML = items && items.length ? `<div class="ilist">${items.join('')}</div>`
    : `<div class="panel-placeholder">${empty}</div>`;
}

function fmtLft(sec) {
  if (sec == null) return '';
  if (sec >= 86400) return Math.round(sec / 86400) + 'd';
  if (sec >= 3600) return Math.round(sec / 3600) + 'h';
  if (sec >= 60) return Math.round(sec / 60) + 'm';
  return sec + 's';
}

// --- item builders ---------------------------------------------------------

function ifaceItems(n) {
  const items = (n.interfaces || []).map(i => {
    const addrAll = (i.addresses || []);
    const UNSTABLE = new Set(['temporary', 'deprecated', 'privacy']);
    let shown = addrAll.filter(a => !UNSTABLE.has(a.kind));
    const hasGlobalV6 = arr => arr.some(a => a.family === 'inet6' && a.scope === 'global');
    if (!hasGlobalV6(shown) && hasGlobalV6(addrAll)) shown = addrAll;
    const v4 = shown.filter(a => a.family === 'inet');
    const v6 = shown.filter(a => a.family === 'inet6');
    const addrHtml = [...v4, ...v6].map(a => {
      const tip = a.kind === 'link-local' ? 'link-local (fe80::)'
        : `${a.kind}${a.preferred != null ? ' · preferred ' + fmtLft(a.preferred) : ''}${a.valid != null ? ' · valid ' + fmtLft(a.valid) : ''}`;
      return `<div class="ilist-addr" title="${escapeHtml(tip)}">${escapeHtml(a.address)}/${a.prefixlen}</div>`;
    }).join('');
    return `<div class="ilist-item">
      <div class="ilist-head">${dot(i.state)}<span class="ilist-title">${escapeHtml(i.name)}</span>
        <span class="ilist-meta">${escapeHtml(i.state || '')}${i.mtu ? ' · MTU ' + i.mtu : ''}</span></div>
      <div class="ilist-addrs">${addrHtml || '<div class="ilist-addr muted">no address</div>'}</div>
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
        <span class="ilist-meta">${r.family === 'inet6' ? 'v6' : 'v4'}${r.protocol ? ' · ' + escapeHtml(r.protocol) : ''}</span></div>
      ${fields ? `<div class="ilist-fields">${fields}</div>` : ''}
    </div>`;
  });
}

function socketItems(list) {
  return (list || []).map(s => `<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(s.local)}</span>
        <span class="ilist-meta">${escapeHtml(s.proto)} · ${escapeHtml(s.state)}</span></div>
      ${s.process ? `<div class="ilist-sub mono">${escapeHtml(s.process)}</div>` : ''}
    </div>`);
}

function firewallItems() {
  const f = firewall;
  if (f === null) return null;
  if (!f.available) return [];
  const out = [`<div class="ilist-item"><div class="ilist-head">
      <span class="ilist-title">nftables</span>
      <span class="ilist-meta">${f.tables} tables · ${f.chains} chains · ${f.rules} rules</span></div></div>`];
  for (const t of f.list) {
    out.push(`<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(t.name)}</span>
        <span class="ilist-meta">${escapeHtml(t.family)} · ${t.chains} chains</span></div></div>`);
  }
  // Listening TCP ports = the practically "open" services.
  out.push('<div class="split-group-title" style="margin-top:8px;">open (listening) TCP ports</div>');
  const tcp = (sockets || []).filter(s => /tcp/i.test(s.proto));
  if (!tcp.length) out.push('<div class="panel-placeholder">none</div>');
  for (const s of tcp) {
    out.push(`<div class="ilist-item">
      <div class="ilist-head"><span class="ilist-title mono">${escapeHtml(s.local)}</span>
        <span class="ilist-meta">${escapeHtml(s.process || '')}</span></div></div>`);
  }
  return out;
}

// --- render ----------------------------------------------------------------

function render() {
  const n = data || { interfaces: [], routes: [], dns: { nameservers: [], search: [] } };
  board('ifacesBoard', ifaceItems(n), 'No interfaces');
  board('routesBoard', routeItems(n), 'No routes');
  board('portsBoard', socketItems(sockets), 'No listening ports');
  const fw = firewallItems();
  board('firewallBoard', fw, fw && fw.length ? 'No firewall data' : 'nftables not available');
}

export async function refreshNetwork() {
  ['ifacesBoard', 'routesBoard', 'portsBoard', 'firewallBoard'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.innerHTML = spinner('Loading…');
  });
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

export function initNetwork() { /* refreshed on tab activation by services.mjs */ }

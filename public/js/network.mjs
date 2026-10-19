// network.mjs — network views for the System page tabs.
//   Interfaces / Routes / Ports → data tables
//   Firewall → small cards tagged 4 (IPv4) / 6 (IPv6) + open (listening) ports
// Read-only; data from /api/sys/network{,/sockets,/firewall}.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;      // { interfaces, routes, dns }
let sockets = null;
let firewall = null;

function setHTML(id, html) { const e = document.getElementById(id); if (e) e.innerHTML = html; }

function dot(state) {
  const cls = state === 'UP' ? 'ok' : state === 'DOWN' ? 'off' : 'warn';
  return `<span class="svc-dot ${cls}"></span>`;
}

function fmtLft(sec) {
  if (sec == null) return '';
  if (sec >= 86400) return Math.round(sec / 86400) + 'd';
  if (sec >= 3600) return Math.round(sec / 3600) + 'h';
  if (sec >= 60) return Math.round(sec / 60) + 'm';
  return sec + 's';
}

/** Stable addresses only (hide temporary/deprecated/privacy; fall back if all). */
function stableAddrs(list) {
  const UNSTABLE = new Set(['temporary', 'deprecated', 'privacy']);
  let shown = (list || []).filter(a => !UNSTABLE.has(a.kind));
  const hasGlobalV6 = arr => arr.some(a => a.family === 'inet6' && a.scope === 'global');
  if (!hasGlobalV6(shown) && hasGlobalV6(list || [])) shown = list;
  return shown;
}

function table(headers, rows, emptyCols) {
  const th = headers.map((h, i) => `<th class="${h.num ? 'num' : ''}">${h.label != null ? h.label : h}</th>`).join('');
  const body = rows.length
    ? rows.join('')
    : `<tr><td class="empty" colspan="${emptyCols}">No data</td></tr>`;
  return `<table class="data-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

// --- Interfaces ------------------------------------------------------------

function interfacesTable(n) {
  const ifaces = n.interfaces || [];
  const rows = ifaces.map(i => {
    const addrs = stableAddrs(i.addresses).map(a => {
      const tip = a.kind === 'link-local' ? 'link-local (fe80::)'
        : `${a.kind}${a.preferred != null ? ' · preferred ' + fmtLft(a.preferred) : ''}${a.valid != null ? ' · valid ' + fmtLft(a.valid) : ''}`;
      return `<span title="${escapeHtml(tip)}">${escapeHtml(a.address)}/${a.prefixlen}</span>`;
    }).join('<br>') || '<span class="muted">—</span>';
    return `<tr>
      <td class="mono">${dot(i.state)}${escapeHtml(i.name)}</td>
      <td>${escapeHtml(i.state || '')}</td>
      <td class="num">${i.mtu || ''}</td>
      <td class="mono addrs">${addrs}</td>
      <td class="mono">${escapeHtml(i.mac || '—')}</td>
    </tr>`;
  });
  return table(['Interface', 'State', { label: 'MTU', num: true }, 'Addresses', 'MAC'], rows, 5);
}

/** DNS as its own full-width card above the interfaces table. */
function dnsCard(n) {
  const dns = n.dns || { nameservers: [], search: [] };
  if (!dns.nameservers.length && !dns.search.length) return '';
  return `<div class="card dns-card">
    <div class="card-title">DNS</div>
    <div class="dns-row">${(dns.nameservers || []).map(s => `<span class="ilist-addr mono">${escapeHtml(s)}</span>`).join('') || '<span class="muted">—</span>'}
      ${dns.search.length ? `<span class="ilist-sub" style="margin-left:auto;">search ${escapeHtml(dns.search.join(' '))}</span>` : ''}</div>
  </div>`;
}

// --- Routes ----------------------------------------------------------------

function routesTable(n) {
  const routes = n.route4 || [];
  const rows = routes.map(r => `<tr>
      <td class="mono">${escapeHtml(r.destination)}</td>
      <td class="mono">${escapeHtml(r.gateway)}</td>
      <td class="mono">${escapeHtml(r.genmask)}</td>
      <td class="mono"><span class="fam">${escapeHtml(r.flags)}</span></td>
      <td class="num">${r.metric}</td>
      <td class="mono">${escapeHtml(r.iface)}</td>
    </tr>`);
  return table(['Destination', 'Gateway', 'Genmask', 'Flags', { label: 'Metric', num: true }, 'Iface'], rows, 6);
}

// --- Ports -----------------------------------------------------------------

function portsTable(list) {
  const isV6 = s => (String(s || '').match(/:/g) || []).length > 1 || String(s || '').startsWith('[');
  const rows = (list || []).map(s => `<tr>
      <td><span class="fam fam-${isV6(s.local) ? '6' : '4'}">${isV6(s.local) ? '6' : '4'}</span> ${escapeHtml(s.proto)}</td>
      <td class="mono">${escapeHtml(s.local)}</td>
      <td>${escapeHtml(s.state)}</td>
      <td class="mono muted">${escapeHtml(s.process || '')}</td>
    </tr>`);
  return table(['Proto', 'Local address', 'State', 'Process'], rows, 4);
}

// --- Firewall --------------------------------------------------------------

function famBadge(family) {
  const f = String(family || '');
  if (f === 'ip') return '<span class="fw-badge">4</span>';
  if (f === 'ip6') return '<span class="fw-badge v6">6</span>';
  if (f === 'inet') return '<span class="fw-badge">4</span><span class="fw-badge v6">6</span>';
  return `<span class="fw-badge other">${escapeHtml(f.slice(0, 3))}</span>`;
}

function firewallHtml() {
  const f = firewall;
  if (!f) return spinner('Loading…');
  if (!f.available) return '<div class="panel-placeholder">nftables not available</div>';
  const cards = `<div class="fw-cards">` + f.list.map(t => `
      <div class="fw-card">${famBadge(t.family)}
        <span class="fw-name">${escapeHtml(t.name)}</span>
        <span class="fw-meta">${t.chains} chains</span>
      </div>`).join('') + `</div>`;
  const summary = `<div class="ilist-sub" style="margin:0 0 8px;">nftables · ${f.tables} tables · ${f.chains} chains · ${f.rules} rules</div>`;
  const tcp = (sockets || []).filter(s => /tcp/i.test(s.proto));
  const open = `<div class="disk-title" style="margin-top:16px;">Open (listening) TCP ports</div>` +
    (tcp.length ? portsTable(tcp) : '<div class="panel-placeholder">none</div>');
  return summary + cards + open;
}

// --- render ----------------------------------------------------------------

function render() {
  const n = data || { interfaces: [], routes: [], route4: [], dns: { nameservers: [], search: [] } };
  setHTML('ifacesBoard', dnsCard(n) + interfacesTable(n));
  setHTML('routesBoard', routesTable(n));
  setHTML('portsBoard', portsTable(sockets));
  setHTML('firewallBoard', firewallHtml());
}

export async function refreshNetwork() {
  ['ifacesBoard', 'routesBoard', 'portsBoard', 'firewallBoard'].forEach(id => setHTML(id, spinner('Loading…')));
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

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
  const dns = (n.dns && n.dns.nameservers.length)
    ? `<tr><td class="mono">DNS</td><td colspan="4" class="mono addrs">${n.dns.nameservers.map(escapeHtml).join('<br>')}${n.dns.search.length ? `<br><span class="muted">search ${escapeHtml(n.dns.search.join(' '))}</span>` : ''}</td></tr>`
    : '';
  return table(['Interface', 'State', { label: 'MTU', num: true }, 'Addresses', 'MAC'],
    rows.concat(dns ? [dns] : []), 5);
}

// --- Routes ----------------------------------------------------------------

function routesTable(n) {
  const routes = n.routes || [];
  const rows = routes.map(r => `<tr>
      <td class="mono">${escapeHtml(r.dst)}</td>
      <td><span class="fam fam-${r.family === 'inet6' ? '6' : '4'}">${r.family === 'inet6' ? '6' : '4'}</span></td>
      <td class="mono">${escapeHtml(r.gateway || '')}</td>
      <td class="mono">${escapeHtml(r.dev || '')}</td>
      <td class="mono">${escapeHtml(r.prefsrc || '')}</td>
      <td class="num">${r.metric != null ? r.metric : ''}</td>
    </tr>`);
  return table(['Destination', 'Fam', 'Gateway', 'Device', 'Source', { label: 'Metric', num: true }], rows, 6);
}

// --- Ports -----------------------------------------------------------------

function portsTable(list) {
  const rows = (list || []).map(s => `<tr>
      <td><span class="fam fam-${/6/.test(s.local) ? '6' : '4'}">${/6/.test(s.local) ? '6' : '4'}</span> ${escapeHtml(s.proto)}</td>
      <td>${escapeHtml(s.state)}</td>
      <td class="mono">${escapeHtml(s.local)}</td>
      <td class="mono muted">${escapeHtml(s.process || '')}</td>
    </tr>`);
  return table(['Proto', 'State', 'Local address', 'Process'], rows, 4);
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
    (tcp.length
      ? '<div class="fw-cards">' + tcp.map(s => `
          <div class="fw-card">${famBadge(/6/.test(s.local) ? 'ip6' : 'ip')}
            <span class="fw-name">${escapeHtml(s.local)}</span>
            <span class="fw-meta">${escapeHtml(s.process || '')}</span>
          </div>`).join('') + '</div>'
      : '<div class="panel-placeholder">none</div>');
  return summary + cards + open;
}

// --- render ----------------------------------------------------------------

function render() {
  const n = data || { interfaces: [], routes: [], dns: { nameservers: [], search: [] } };
  setHTML('ifacesBoard', interfacesTable(n));
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

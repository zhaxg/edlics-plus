// network-api.js — read-only network view: interfaces, routes, DNS, sockets,
// firewall (nftables). All reads, so no --admin-write needed; still behind
// --admin like every /api/sys route.
//
// Parsers target the machine-readable output (`ip -j`, `ss -j`, `nft -j`) and
// are pure/testable; text fallbacks exist only where a tool lacks JSON.
const { execFile } = require('child_process');
const fs = require('fs');

// Read-only queries: resolve whatever stdout we got even if the tool exited
// non-zero (some iproute2 builds fault on `ip -j route` yet still emit the
// full JSON). Reject only when there is no usable output at all.
function run(file, args, timeout = 10000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      if (err && !out.trim()) { err.stderr = String(stderr || '').slice(0, 500); return reject(err); }
      resolve(out);
    });
  });
}

const jparse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

// --- pure parsers (exported for tests) -------------------------------------

/** Classify one addr_info entry so the UI can explain what each address is. */
function addrKind(a) {
  if (a.scope === 'link') return 'link-local';
  if (a.temporary) return 'temporary';
  if (a.deprecated) return 'deprecated';
  if (a.protocol === 'kernel_ra') return 'eui-64';   // SLAAC from the MAC
  if (a.mngtmpaddr) return 'privacy';                // RFC 7217 / managed temp
  return 'global';
}

/** `ip -j addr` → [{name, state, mac, mtu, addresses:[…], v4, v6}] */
function parseIpAddr(json) {
  const arr = jparse(json, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(l => {
    const addresses = (l.addr_info || []).map(a => ({
      family: a.family, address: a.local, prefixlen: a.prefixlen,
      scope: a.scope, kind: addrKind(a), dynamic: !!a.dynamic,
      preferred: a.preferred_life_time, valid: a.valid_life_time,
    }));
    return {
      name: l.ifname,
      state: l.operstate,
      mac: l.address,
      mtu: l.mtu,
      addresses,
      v4: addresses.filter(a => a.family === 'inet').map(a => a.address),
      v6: addresses.filter(a => a.family === 'inet6').map(a => a.address),
    };
  }).filter(l => l.name);
}

/** Little-endian hex (as in /proc/net/route) → dotted IPv4. Pure; tested. */
function hexToIp(h) {
  const n = parseInt(h, 16) >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

/** /proc/net/route flag bits → route(8) style letters (e.g. "UG"). Pure. */
function routeFlags(hex) {
  const n = parseInt(hex, 16) || 0;
  let s = '';
  if (n & 0x0001) s += 'U';   // RTF_UP
  if (n & 0x0002) s += 'G';   // RTF_GATEWAY
  if (n & 0x0004) s += 'H';   // RTF_HOST
  if (n & 0x0008) s += 'R';   // RTF_REINSTATE
  if (n & 0x0010) s += 'D';   // RTF_DYNAMIC
  if (n & 0x0020) s += 'M';   // RTF_MODIFIED
  if (n & 0x0200) s += '!';   // RTF_REJECT
  return s || '0';
}

/**
 * Parse /proc/net/route → IPv4 routing table (route -n columns).
 * @returns {{destination:string,gateway:string,genmask:string,flags:string,metric:number,iface:string}[]}
 */
function parseProcNetRoute(text) {
  const out = [];
  const lines = String(text || '').split('\n').filter(l => l.trim());
  for (const line of lines.slice(1)) {           // skip header
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    out.push({
      iface: f[0],
      destination: hexToIp(f[1]),
      gateway: hexToIp(f[2]),
      flags: routeFlags(f[3]),
      metric: parseInt(f[6], 10) || 0,
      genmask: hexToIp(f[7]),
    });
  }
  return out;
}

/** `ip -j route` → [{dst, gateway, dev, metric, protocol}] */
function parseRoutes(json) {
  const arr = jparse(json, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(r => ({
    dst: r.dst || 'default',
    gateway: r.gateway || null,
    dev: r.dev || null,
    prefsrc: r.prefsrc || null,
    metric: r.metric != null ? r.metric : null,
    protocol: r.protocol || null,
  }));
}

/** Text fallback for `ip route` (used when the JSON form is truncated). */
function parseRoutesText(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.trim();
    if (!f) continue;
    const dst = f.startsWith('default') ? 'default' : f.split(/\s+/)[0];
    const gw = /\bvia\s+(\S+)/.exec(f);
    const dev = /\bdev\s+(\S+)/.exec(f);
    const src = /\bsrc\s+(\S+)/.exec(f);
    const metric = /\bmetric\s+(\d+)/.exec(f);
    out.push({
      dst, gateway: gw ? gw[1] : null, dev: dev ? dev[1] : null,
      prefsrc: src ? src[1] : null, metric: metric ? Number(metric[1]) : null, protocol: null,
    });
  }
  return out;
}

/** `/etc/resolv.conf` → {nameservers, search} */
function parseResolvConf(text) {
  const nameservers = [], search = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(nameserver|search|domain)\s+(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'nameserver') nameservers.push(m[2].trim());
    else search.push(...m[2].trim().split(/\s+/));
  }
  return { nameservers, search };
}

/** `ss -j` → [{proto, state, local, peer, process}] */
function parseSockets(json) {
  const arr = jparse(json, []);
  const list = Array.isArray(arr) ? arr : (arr && arr.sockets) || [];
  if (!Array.isArray(list)) return [];
  return list.map(s => ({
    proto: s.netid || '',
    state: s.state || '',
    local: `${s.local_addr || ''}${s.local_port != null ? ':' + s.local_port : ''}`,
    peer: `${s.peer_addr || ''}${s.peer_port != null ? ':' + s.peer_port : ''}`,
    process: (s.processes || []).map(p => `${p.name}/${p.pid}`).join(', '),
  }));
}

/** Text fallback for `ss -tulpn` (this build has no `-j`). */
function parseSocketsText(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  // Newer iproute2 prints a leading "Netid" column; data rows then shift by 1.
  const header = lines.find(l => /\b(State|Netid)\b/.test(l)) || '';
  const hasNetid = /^\s*Netid\b/.test(header);
  const base = hasNetid ? 1 : 0;
  const localIdx = 3 + base, peerIdx = 4 + base;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const f = trimmed.split(/\s+/);
    if (f[0] === 'State' || f[0] === 'Netid' || f.length <= peerIdx) continue;
    const proc = trimmed.match(/users:\(\((.*?)\)\)/);
    out.push({
      proto: hasNetid ? f[0] : (/udp/i.test(trimmed) ? 'udp' : 'tcp'),
      state: f[base],
      local: f[localIdx],
      peer: f[peerIdx] || '',
      process: proc ? proc[1].replace(/"/g, '') : '',
    });
  }
  return out;
}

/**
 * `nft -j list ruleset` → {available, tables, chains, rules, list:[{family,name,chains}]}
 * Pure; tested.
 */
function parseNft(json) {
  const root = jparse(json, null);
  const items = root && Array.isArray(root.nftables) ? root.nftables : null;
  if (!items) return { available: false, tables: 0, chains: 0, rules: 0, list: [] };
  const tables = new Map();
  let chains = 0, rules = 0;
  for (const it of items) {
    if (it.table) {
      tables.set(`${it.table.family} ${it.table.name}`, { family: it.table.family, name: it.table.name, chains: 0 });
    } else if (it.chain) {
      chains++;
      const key = `${it.chain.family} ${it.chain.table}`;
      if (tables.has(key)) tables.get(key).chains++;
    } else if (it.rule) {
      rules++;
    }
  }
  const list = [...tables.values()];
  return { available: true, tables: list.length, chains, rules, list };
}

// --- handlers --------------------------------------------------------------

function readResolvConf() {
  try { return parseResolvConf(fs.readFileSync('/etc/resolv.conf', 'utf-8')); } catch { return { nameservers: [], search: [] }; }
}

async function handleNetwork(ctx) {
  try {
    const addrJson = await run('ip', ['-j', 'addr']).catch(() => '[]');
    // `ip -j route` can segfault after printing truncated JSON on some
    // iproute2 builds → fall back to the text form when parsing yields nothing.
    let routes = parseRoutes(await run('ip', ['-j', 'route']).catch(() => '[]'));
    if (!routes.length) routes = parseRoutesText(await run('ip', ['route']).catch(() => ''));
    let routes6 = parseRoutes(await run('ip', ['-j', '-6', 'route']).catch(() => '[]'));
    if (!routes6.length) routes6 = parseRoutesText(await run('ip', ['-6', 'route']).catch(() => ''));
    const route4 = parseProcNetRoute(fs.readFileSync('/proc/net/route', 'utf-8'));
    ctx.ok({
      interfaces: parseIpAddr(addrJson),
      routes: routes.concat(routes6.map(r => ({ ...r, family: 'inet6' }))),
      route4,
      dns: readResolvConf(),
    });
  } catch (e) { ctx.fail('network query failed: ' + (e.stderr || e.message)); }
}

async function handleSockets(ctx) {
  try {
    let sockets;
    try {
      sockets = parseSockets(await run('ss', ['-j', '-tulpn']));
    } catch {
      sockets = parseSocketsText(await run('ss', ['-tulpn']));
    }
    ctx.ok({ sockets: sockets.slice(0, 500) });
  } catch (e) { ctx.fail('ss failed: ' + (e.stderr || e.message)); }
}

async function handleFirewall(ctx) {
  try {
    const json = await run('nft', ['-j', 'list', 'ruleset']).catch(() => '');
    const fw = json ? parseNft(json) : { available: false, tables: 0, chains: 0, rules: 0, list: [] };
    ctx.ok({ firewall: fw });
  } catch (e) { ctx.fail('nft failed: ' + (e.stderr || e.message)); }
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/network',          match: p => p[1] === 'sys' && p[2] === 'network' && !p[3],           handle: ctx => handleNetwork(ctx) },
  { name: 'api/sys/network/sockets',  match: p => p[1] === 'sys' && p[2] === 'network' && p[3] === 'sockets', handle: ctx => handleSockets(ctx) },
  { name: 'api/sys/network/firewall', match: p => p[1] === 'sys' && p[2] === 'network' && p[3] === 'firewall', handle: ctx => handleFirewall(ctx) },
];

module.exports = {
  routes, parseIpAddr, parseRoutes, parseRoutesText, parseResolvConf, parseSockets, parseSocketsText, parseNft,
  parseProcNetRoute, hexToIp, routeFlags,
};

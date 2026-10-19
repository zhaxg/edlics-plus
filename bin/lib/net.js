// net.js — client-address resolution (trusted-proxy aware) and CIDR allowlist.
//
// Pure and testable. Used by the dispatcher to (a) decide the real client IP
// for lockout/rate-limit keys and (b) enforce an optional --allow allowlist
// BEFORE any request logic runs.
const net = require('net');

/** Strip an IPv4-mapped IPv6 prefix. */
function normalizeIp(ip) {
  if (!ip) return '';
  const s = String(ip).trim();
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s;
}

/**
 * Resolve the client IP.
 * @param {import('http').IncomingMessage} req
 * @param {number} trustProxy  0 = ignore X-Forwarded-For; N = trust the last N
 *   proxies (take the Nth-from-right XFF entry; the rightmost entries are the
 *   closer, trusted hops).
 */
function clientIp(req, trustProxy = 0) {
  const sock = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!trustProxy) return sock;
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map(s => normalizeIp(s)).filter(Boolean);
  if (!xff.length) return sock;
  const idx = Math.max(0, xff.length - trustProxy);
  return xff[idx];
}

/** Expand an IPv4 or IPv6 address to a BigInt + bit width, or null. */
function ipToBigInt(ip) {
  const s = normalizeIp(ip);
  if (net.isIPv4(s)) {
    return s.split('.').reduce((acc, o) => (acc << 8n) | BigInt(parseInt(o, 10)), 0n);
  }
  if (net.isIPv6(s)) {
    const [head, tail] = s.includes('::') ? s.split('::') : [s, ''];
    const left = head ? head.split(':').filter(Boolean) : [];
    const right = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - (left.length + right.length);
    const groups = [...left, ...Array(missing > 0 ? missing : 0).fill('0'), ...right];
    return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
  }
  return null;
}

const IPV4_BITS = 32n;

/**
 * Does `ip` fall inside `cidr` ("10.0.0.0/24") or equal a bare address?
 * IPv4 and IPv6 supported; mixed families never match. Pure; tested.
 */
function ipInCidr(ip, cidr) {
  const [base, lenStr] = String(cidr || '').split('/');
  const v4 = net.isIPv4(normalizeIp(ip)) && net.isIPv4(base);
  const v6 = net.isIPv6(normalizeIp(ip)) && net.isIPv6(base);
  if (!v4 && !v6) return false;
  const width = v4 ? IPV4_BITS : 128n;
  const len = lenStr == null ? width : BigInt(parseInt(lenStr, 10));
  if (len < 0n || len > width) return false;
  const a = ipToBigInt(ip), b = ipToBigInt(base);
  if (a === null || b === null) return false;
  const shift = width - len;
  return (a >> shift) === (b >> shift);
}

/** Parse a comma/space separated allowlist into an array of CIDRs. */
function parseAllowlist(str) {
  return String(str || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

/** True when `ip` is permitted by `allow` (empty list ⇒ allow all). */
function isAllowed(ip, allow) {
  if (!allow || allow.length === 0) return true;
  return allow.some(c => ipInCidr(ip, c));
}

/** Loopback-only bind addresses. */
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Decide whether a plain-HTTP bind needs a loud security warning.
 *
 * Exposed when the server listens on a non-loopback address without TLS
 * (there is no TLS terminator in this server) **and** without an allowlist:
 * the password and the session cookie then travel in clear text, so anyone on
 * the path can read them and replay the cookie for the rest of its lifetime.
 *
 * Pure; tested.
 * @param {{hostname?:string, allow?:string[]|string, cookieSecure?:boolean}} opts
 * @returns {boolean}
 */
function needsInsecureWarning(opts = {}) {
  const host = String(opts.hostname || '127.0.0.1').trim();
  const exposed = !LOCAL_HOSTS.has(host);
  if (!exposed) return false;
  const allow = Array.isArray(opts.allow) ? opts.allow : parseAllowlist(opts.allow);
  return allow.length === 0;
}

/**
 * Human-readable explanation lines for {@link needsInsecureWarning}.
 * @param {{hostname?:string, port?:number, allow?:string[]|string}} opts
 * @returns {string[]}
 */
function insecureWarningLines(opts = {}) {
  const host = opts.hostname || '127.0.0.1';
  const port = opts.port || 3000;
  return [
    `Listening on ${host}:${port} over plain HTTP with no --allow allowlist.`,
    'Anyone who can reach this port — or sniff the network path — can read the',
    'login password and the session cookie in clear text, then reuse the cookie',
    'until it expires. Brute-force protection does not help against that.',
    '',
    'Safer options (any one is enough):',
    '  · Keep it private: bind 127.0.0.1 and use an SSH tunnel',
    '      ssh -L ' + port + ':127.0.0.1:' + port + ' user@this-host',
    '  · Put TLS in front (Caddy/nginx) and start with --cookie-secure',
    '  · Restrict callers with --allow <CIDR>[,<CIDR>] behind a firewall',
  ];
}

module.exports = {
  normalizeIp, clientIp, ipInCidr, parseAllowlist, isAllowed, ipToBigInt,
  needsInsecureWarning, insecureWarningLines, LOCAL_HOSTS,
};

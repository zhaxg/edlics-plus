// format.mjs — shared value formatters used by the console views.

/** Human-readable byte size (B/KB/MB/GB/TB/PB). */
export function fmtBytes(n) {
  if (!n || n < 0 || !Number.isFinite(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

/** Compact size for process RSS (B/K/M/G/T). */
export function fmtRss(n) {
  if (!n) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + u[i];
}

/** Uptime seconds → "3d 4h" / "4h 12m" / "12m". */
export function fmtUptime(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Percentage of `used` within `total`, or null when total is 0. */
export function pct(used, total) {
  return total > 0 ? 100 * used / total : null;
}

/** Strip a trailing percent sign and parse (e.g. "42%" → 42). */
export function parsePct(s) {
  const n = parseFloat(String(s == null ? '' : s).replace('%', ''));
  return Number.isFinite(n) ? n : 0;
}

/** Local time string for a timestamp (seconds or ms). */
export function fmtTime(ts, opts) {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString(undefined, opts);
}

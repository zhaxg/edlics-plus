// services-api.js — systemd service listing, journal logs and lifecycle actions.
//
// Safety model (docs/ADMIN-PANEL-PLAN.md Phase 4):
//   * execFile only, never a shell; fixed argument templates.
//   * A unit name must be BOTH shape-valid (…​.service) AND present in the live
//     systemctl enumeration before it is touched — so nothing client-supplied
//     ever reaches an argv position unchecked.
//   * Actions require --admin-write and are audited. --readonly always wins.
const { execFile } = require('child_process');
const fs = require('fs');
const audit = require('./audit');

// First char must be alphanumeric so a unit can never be read as a CLI option
// (argv injection like "--now.service" is rejected before systemctl sees it).
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);
const MAX_LOG_LINES = 1000;
const UNIT_TTL_MS = 5000;

let unitCache = { at: 0, set: new Set() };

/** Is this a real systemd host? (avoids confusing errors in containers) */
function systemdAvailable() {
  try { return fs.existsSync('/run/systemd/system'); } catch { return false; }
}

/** Shape check — necessary but not sufficient (see isKnownUnit). Pure; tested. */
function isValidUnitName(name) {
  return typeof name === 'string' && name.length <= 128 && UNIT_RE.test(name);
}

/**
 * Parse `systemctl list-units --output=json` → [{name, load, active, sub, description}].
 * Pure; tested.
 */
function parseUnitList(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(u => ({
    name: u.unit,
    load: u.load,
    active: u.active,          // active | inactive | failed | activating | deactivating
    sub: u.sub,
    description: u.description || '',
  })).filter(u => u.name && u.name.endsWith('.service'));
}

/** Parse `systemctl list-unit-files --output=json` → Set of unit names. Pure; tested. */
function parseUnitFiles(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return new Set(); }
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.map(u => u.unit_file).filter(n => n && n.endsWith('.service')));
}

/**
 * Parse `journalctl -o json` (JSON-lines) → newest-last entries.
 * Pure; tested.
 */
function parseJournal(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    let msg = o.MESSAGE;
    // binary messages arrive as byte arrays — decode rather than drop
    if (Array.isArray(msg)) { try { msg = Buffer.from(msg).toString('utf-8'); } catch { msg = ''; } }
    const ts = o.__REALTIME_TIMESTAMP ? Number(o.__REALTIME_TIMESTAMP) / 1000 : Date.now();
    out.push({
      ts,
      priority: Number(o.PRIORITY != null ? o.PRIORITY : 6),
      message: String(msg == null ? '' : msg),
      comm: o._COMM || o.SYSLOG_IDENTIFIER || '',
      pid: o._PID ? Number(o._PID) : null,
      unit: o._SYSTEMD_UNIT || o.UNIT || null,
    });
  }
  return out;
}

const PRIORITY_LABEL = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

// --- execFile wrapper ------------------------------------------------------

function run(file, args, timeout = 15000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 500); return reject(err); }
      resolve(String(stdout));
    });
  });
}

function systemctl(args, timeout) { return run('systemctl', args, timeout); }
function journalctl(args, timeout) { return run('journalctl', args, timeout); }

/** Refresh the known-unit set from systemctl (list-units + list-unit-files). */
async function refreshUnits() {
  const [unitsOut, filesOut] = await Promise.all([
    systemctl(['list-units', '--type=service', '--all', '--no-pager', '--output=json']).catch(() => '[]'),
    systemctl(['list-unit-files', '--type=service', '--no-pager', '--output=json']).catch(() => '[]'),
  ]);
  const set = new Set();
  for (const u of parseUnitList(unitsOut)) set.add(u.name);
  for (const n of parseUnitFiles(filesOut)) set.add(n);
  unitCache = { at: Date.now(), set };
  return set;
}

/** A unit is actionable only if it exists in the live enumeration. */
async function isKnownUnit(name) {
  if (!isValidUnitName(name)) return false;
  if (Date.now() - unitCache.at > UNIT_TTL_MS) { try { await refreshUnits(); } catch { /* keep stale */ } }
  if (unitCache.set.has(name)) return true;
  try { return (await refreshUnits()).has(name); } catch { return false; }
}

// --- handlers --------------------------------------------------------------

async function handleList(ctx) {
  if (!systemdAvailable()) return ctx.fail('systemd is not available on this host', 501);
  if (ctx.params.refresh === '1') { try { await refreshUnits(); } catch {} }
  try {
    const out = await systemctl(['list-units', '--type=service', '--all', '--no-pager', '--output=json']);
    const units = parseUnitList(out);
    const q = (ctx.params.q || '').toLowerCase();
    const filtered = q
      ? units.filter(u => u.name.toLowerCase().includes(q) || (u.description || '').toLowerCase().includes(q))
      : units;
    ctx.ok({ units: filtered, total: units.length });
  } catch (e) { ctx.fail('systemctl failed: ' + (e.stderr || e.message)); }
}

async function handleLogs(ctx) {
  if (!systemdAvailable()) return ctx.fail('systemd is not available on this host', 501);
  const { params, ok, fail } = ctx;
  if (!await isKnownUnit(params.unit)) return fail('Unknown or invalid unit', 400);
  const lines = Math.min(MAX_LOG_LINES, Math.max(1, parseInt(params.lines, 10) || 200));
  const args = ['-u', params.unit, '-n', String(lines), '-o', 'json', '--no-pager', '--no-hostname'];
  if (params.priority && /^[0-7]$/.test(params.priority)) args.unshift('-p', params.priority);
  try {
    const out = await journalctl(args, 20000);
    ok({ unit: params.unit, lines: parseJournal(out), priorityLabels: PRIORITY_LABEL });
  } catch (e) { fail('journalctl failed: ' + (e.stderr || e.message)); }
}

function readJsonBody(req, cb, max = 8 * 1024) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

function handleAction(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Write actions are disabled. Start with --admin-write to enable them.', 403);
  return readJsonBody(req, async data => {
    if (!data) return fail('Invalid JSON', 400);
    const { unit, action } = data;
    if (!ACTIONS.has(action)) return fail('Unsupported action', 400);
    if (!await isKnownUnit(unit)) return fail('Unknown or invalid unit', 400);
    try {
      await systemctl([action, unit], 30000);
      audit.log('service.' + action, {
        ip: req.socket.remoteAddress || 'unknown', ua: req.headers['user-agent'] || '',
        target: unit, result: 'ok',
      });
      ok({ ok: true, unit, action });
    } catch (e) {
      const msg = e.stderr || e.message;
      audit.log('service.' + action, {
        ip: req.socket.remoteAddress || 'unknown', ua: req.headers['user-agent'] || '',
        target: unit, result: 'fail: ' + msg,
      });
      fail('systemctl ' + action + ' failed: ' + msg);
    }
  });
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/services',        match: p => p[1] === 'sys' && p[2] === 'services' && !p[3],                    handle: ctx => handleList(ctx) },
  { name: 'api/sys/services/logs',   match: p => p[1] === 'sys' && p[2] === 'services' && p[3] === 'logs',          handle: ctx => handleLogs(ctx) },
  { name: 'api/sys/services/action', match: p => p[1] === 'sys' && p[2] === 'services' && p[3] === 'action',        handle: handleAction },
];

module.exports = {
  routes, isValidUnitName, parseUnitList, parseUnitFiles, parseJournal,
  systemdAvailable, ACTIONS, PRIORITY_LABEL, MAX_LOG_LINES,
  _refreshUnits: refreshUnits, _isKnownUnit: isKnownUnit,
};

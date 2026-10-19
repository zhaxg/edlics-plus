// container-api.js — Docker containers and compose projects.
//
// Read + (with --admin-write) lifecycle actions. Every container ref and
// compose project name is validated against the LIVE enumeration before any
// command runs — nothing client-supplied reaches argv unchecked. Actions are
// audited. Console (docker exec) is handled by the terminal module.
const { execFile } = require('child_process');
const audit = require('./audit');

const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart']);
const COMPOSE_ACTIONS = {
  up: ['up', '-d'],
  stop: ['stop'],
  build: ['build'],
  down: ['down', '--remove-orphans'],
  downv: ['down', '-v', '--remove-orphans'],
};

function run(file, args, timeout = 20000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 500); return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

/** docker logs writes to both streams — capture them together. */
function runCombined(file, args, timeout = 20000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(err);
      resolve(String(stdout || '') + (stderr ? String(stderr) : ''));
    });
  });
}

const jlines = (text) => String(text || '').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const jparse = (text, fb) => { try { return JSON.parse(text); } catch { return fb; } };

// --- pure parsers (exported for tests) -------------------------------------

/** Parse the docker "Ports" string → [{host, hostPort, containerPort, proto}]. */
function parsePorts(s) {
  const out = [];
  const seen = new Set();
  for (const part of String(s || '').split(',')) {
    const m = /^([^\s:]+|\S*?):(\d+)->(\d+)\/(\w+)$/.exec(part.trim());
    if (!m) continue;
    const key = m[2] + '/' + m[4];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: m[1], hostPort: Number(m[2]), containerPort: Number(m[3]), proto: m[4] });
  }
  return out;
}

/** Extract com.docker.compose.project from a docker Labels string. */
function projectOf(labels) {
  const m = /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(String(labels || ''));
  return m ? m[1] : null;
}

/** Parse a raw `docker ps --format '{{json .}}'` line. */
function parseContainer(c) {
  return {
    id: c.ID || '',
    name: c.Names || '',
    image: c.Image || '',
    state: c.State || '',
    status: c.Status || '',
    created: c.CreatedAt || '',
    project: projectOf(c.Labels),
    ports: parsePorts(c.Ports),
    portsText: c.Ports || '',
  };
}

/** `docker ps --format '{{json .}}'` → containers */
function parseDockerPs(text) {
  return jlines(text).map(parseContainer).filter(c => c.id || c.name);
}

/** `docker stats --no-stream --format '{{json .}}'` → {name|id12: usage}. */
function parseDockerStats(text) {
  const out = {};
  for (const s of jlines(text)) {
    const row = {
      cpu: s.CPUPerc || '', mem: s.MemUsage || '', memPerc: s.MemPerc || '',
      net: s.NetIO || '', block: s.BlockIO || '', pids: s.PIDs || '',
    };
    if (s.Name) out[s.Name] = row;
    if (s.ID) out[s.ID.slice(0, 12)] = row;
  }
  return out;
}

/** `docker compose ls --format json` → [{name, status, configFiles}] */
function parseComposeLs(text) {
  let arr = jparse(text, null);
  if (!Array.isArray(arr)) arr = jlines(text);
  if (!Array.isArray(arr)) return [];
  return arr.map(p => ({
    name: p.Name || p.name || '',
    status: p.Status || p.status || '',
    configFiles: p.ConfigFiles || p.configFiles || '',
  })).filter(p => p.name);
}

/** A container ref is safe onward only if it matches id/name shape. */
function isValidContainerRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 128) return false;
  return /^[a-f0-9]{12,64}$/i.test(ref) || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ref);
}

// --- handlers --------------------------------------------------------------

async function dockerAvailable() {
  try { await run('docker', ['version', '--format', '{{.Server.Version}}'], 6000); return true; }
  catch { return false; }
}

async function listContainers() {
  const out = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '');
  return parseDockerPs(out);
}

async function listCompose() {
  return parseComposeLs(await run('docker', ['compose', 'ls', '--format', 'json']).catch(() => '[]'));
}

async function handleList(ctx) {
  if (!await dockerAvailable()) return ctx.ok({ available: false, containers: [], compose: [] });
  try {
    // Fast path: ps + compose ls only. Live stats are a separate, slower
    // request (docker stats samples for ~2s) so the list renders immediately.
    const containers = await listContainers();
    const compose = await listCompose();
    for (const p of compose) {
      const owned = containers.filter(c => c.project === p.name);
      p.count = owned.length;
      p.running = owned.filter(c => c.state === 'running').length;
      p.created = owned.map(c => c.created).sort()[0] || '';
    }
    ctx.ok({ available: true, containers, compose });
  } catch (e) { ctx.fail('docker failed: ' + (e.stderr || e.message)); }
}

/** Slow second step: live CPU/mem/net usage for the running containers. */
async function handleStats(ctx) {
  if (!await dockerAvailable()) return ctx.ok({ stats: {} });
  try {
    const out = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], 25000).catch(() => '');
    ctx.ok({ stats: parseDockerStats(out) });
  } catch (e) { ctx.fail('docker stats failed: ' + (e.stderr || e.message)); }
}

async function knownContainerRefs() {
  const set = new Set();
  for (const c of await listContainers()) { set.add(c.id); set.add(c.name); }
  return set;
}

async function handleLogs(ctx) {
  if (!await dockerAvailable()) return ctx.fail('docker is not available', 501);
  const ref = ctx.params.id;
  if (!isValidContainerRef(ref)) return ctx.fail('Invalid container reference', 400);
  if (!(await knownContainerRefs()).has(ref)) return ctx.fail('Unknown container', 400);
  const tail = Math.min(2000, Math.max(1, parseInt(ctx.params.tail, 10) || 200));
  try {
    const out = await runCombined('docker', ['logs', '--tail', String(tail), ref]);
    ctx.ok({ id: ref, lines: out.split('\n').slice(-tail) });
  } catch (e) { ctx.fail('docker logs failed: ' + (e.stderr || e.message)); }
}

function readJsonBody(req, cb, max = 8 * 1024) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

function auditAction(req, ctx, action, target, result) {
  audit.log('container.' + action, {
    ip: ctx.clientIp || (req.socket && req.socket.remoteAddress) || 'unknown',
    ua: (req.headers && req.headers['user-agent']) || '', target, result,
  });
}

function handleAction(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Container actions require --admin-write', 403);
  return readJsonBody(req, async data => {
    if (!data) return fail('Invalid JSON', 400);
    const { id, action } = data;
    if (!CONTAINER_ACTIONS.has(action)) return fail('Unsupported action', 400);
    if (!isValidContainerRef(id)) return fail('Invalid container reference', 400);
    if (!(await knownContainerRefs()).has(id)) return fail('Unknown container', 400);
    try {
      await run('docker', [action, id], 60000);
      auditAction(req, ctx, action, id, 'ok');
      ok({ ok: true, id, action });
    } catch (e) {
      const msg = e.stderr || e.message;
      auditAction(req, ctx, action, id, 'fail: ' + msg);
      fail('docker ' + action + ' failed: ' + msg);
    }
  });
}

function handleComposeAction(ctx) {
  const { req, ok, fail, adminWrite, readonly } = ctx;
  if (readonly) return fail('Server is in read-only mode', 403);
  if (!adminWrite) return fail('Compose actions require --admin-write', 403);
  return readJsonBody(req, async data => {
    if (!data) return fail('Invalid JSON', 400);
    const { name, action } = data;
    const args = COMPOSE_ACTIONS[action];
    if (!args) return fail('Unsupported action', 400);
    // Validate against the live `docker compose ls` enumeration and use ITS path.
    const projects = await listCompose().catch(() => []);
    const project = projects.find(p => p.name === name);
    if (!project) return fail('Unknown compose project', 400);
    const files = String(project.configFiles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!files.length) return fail('No compose file for project', 400);
    const cmdArgs = [];
    for (const f of files) { cmdArgs.push('-f', f); }
    cmdArgs.push(...args);
    try {
      await run('docker', ['compose', ...cmdArgs], 120000);
      auditAction(req, ctx, 'compose.' + action, name, 'ok');
      ok({ ok: true, name, action });
    } catch (e) {
      const msg = e.stderr || e.message;
      auditAction(req, ctx, 'compose.' + action, name, 'fail: ' + msg);
      fail('compose ' + action + ' failed: ' + msg);
    }
  });
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/containers',        match: p => p[1] === 'sys' && p[2] === 'containers' && !p[3],          handle: ctx => handleList(ctx) },
  { name: 'api/sys/containers/stats',  match: p => p[1] === 'sys' && p[2] === 'containers' && p[3] === 'stats', handle: ctx => handleStats(ctx) },
  { name: 'api/sys/containers/logs',   match: p => p[1] === 'sys' && p[2] === 'containers' && p[3] === 'logs',  handle: ctx => handleLogs(ctx) },
  { name: 'api/sys/containers/action', match: p => p[1] === 'sys' && p[2] === 'containers' && p[3] === 'action', handle: handleAction },
  { name: 'api/sys/containers/compose', match: p => p[1] === 'sys' && p[2] === 'containers' && p[3] === 'compose', handle: handleComposeAction },
];

module.exports = {
  routes, parseDockerPs, parseDockerStats, parseComposeLs, isValidContainerRef,
  parsePorts, projectOf, CONTAINER_ACTIONS, COMPOSE_ACTIONS,
};

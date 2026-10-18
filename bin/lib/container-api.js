// container-api.js — Docker containers and docker-compose projects (read-only
// this pass). Container IDs/names are validated against the live `docker ps`
// enumeration before any per-container command runs — same discipline as
// services. Write actions are deferred (docker.sock == root-equivalent).
const { execFile } = require('child_process');

function run(file, args, timeout = 15000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

/** docker logs writes to both streams — capture them together. */
function runCombined(file, args, timeout = 15000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(err);
      resolve(String(stdout || '') + (stderr ? String(stderr) : ''));
    });
  });
}

const jlines = (text) => String(text || '').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// --- pure parsers (exported for tests) -------------------------------------

/** `docker ps --format '{{json .}}'` → containers */
function parseDockerPs(text) {
  return jlines(text).map(c => ({
    id: c.ID || '',
    name: c.Names || '',
    image: c.Image || '',
    state: c.State || '',
    status: c.Status || '',
    ports: c.Ports || '',
    created: c.CreatedAt || '',
  })).filter(c => c.id || c.name);
}

/** `docker stats --no-stream --format '{{json .}}'` → live usage rows */
function parseDockerStats(text) {
  return jlines(text).map(s => ({
    id: s.ID || '', name: s.Name || '',
    cpu: s.CPUPerc || '', mem: s.MemUsage || '', memPerc: s.MemPerc || '',
    net: s.NetIO || '', block: s.BlockIO || '', pids: s.PIDs || '',
  }));
}

/** `docker compose ls --format json` → [{name, status, configFiles}] */
function parseComposeLs(text) {
  let arr;
  try { arr = JSON.parse(text); } catch {
    // older compose emits an array of objects across lines — best effort
    arr = jlines(text);
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(p => ({
    name: p.Name || p.name || '',
    status: p.Status || p.status || '',
    configFiles: p.ConfigFiles || p.configFiles || '',
  })).filter(p => p.name);
}

/** A container ref is safe to pass onward only if it matches id/name shape. */
function isValidContainerRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 128) return false;
  return /^[a-f0-9]{12,64}$/i.test(ref) || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ref);
}

// --- handlers --------------------------------------------------------------

async function dockerAvailable() {
  try { await run('docker', ['version', '--format', '{{.Server.Version}}'], 6000); return true; }
  catch { return false; }
}

async function handleList(ctx) {
  if (!await dockerAvailable()) return ctx.ok({ available: false, containers: [], compose: [] });
  try {
    const psOut = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '');
    let compose = [];
    try { compose = parseComposeLs(await run('docker', ['compose', 'ls', '--format', 'json'])); } catch { compose = []; }
    ctx.ok({ available: true, containers: parseDockerPs(psOut), compose });
  } catch (e) { ctx.fail('docker failed: ' + (e.stderr || e.message)); }
}

async function knownContainerRefs() {
  const psOut = await run('docker', ['ps', '-a', '--format', '{{json .}}']).catch(() => '');
  const set = new Set();
  for (const c of parseDockerPs(psOut)) { set.add(c.id); set.add(c.name); }
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
    // docker logs mixes stdout/stderr without ordering guarantees; keep raw lines
    ctx.ok({ id: ref, lines: out.split('\n').slice(-tail) });
  } catch (e) { ctx.fail('docker logs failed: ' + (e.stderr || e.message)); }
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/containers',      match: p => p[1] === 'sys' && p[2] === 'containers' && !p[3],        handle: ctx => handleList(ctx) },
  { name: 'api/sys/containers/logs', match: p => p[1] === 'sys' && p[2] === 'containers' && p[3] === 'logs', handle: ctx => handleLogs(ctx) },
];

module.exports = { routes, parseDockerPs, parseDockerStats, parseComposeLs, isValidContainerRef };

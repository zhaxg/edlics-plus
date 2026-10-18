// cron-api.js — scheduled tasks: user crontabs, /etc/crontab, /etc/cron.d/*,
// and systemd timers. Read-only this pass (editing needs its own safe
// stdin/validation design — see docs/ADMIN-PANEL-PLAN.md Phase 7).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(file, args, timeout = 8000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

// --- pure parser (exported for tests) --------------------------------------

const SPECIAL = new Set(['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);
const ENV_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;

/**
 * Parse a crontab body.
 * @param {string} text
 * @param {boolean} hasUser  /etc/crontab and /etc/cron.d have a user field
 *                           between the schedule and the command
 * @returns {{schedule:string,user:string|null,command:string}[]}
 */
function parseCrontab(text, hasUser) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (ENV_RE.test(line)) continue;            // VAR=value
    if (line.startsWith('@')) {
      const [tok, ...rest] = line.split(/\s+/);
      if (!SPECIAL.has(tok)) continue;
      if (hasUser) out.push({ schedule: tok, user: rest[0] || null, command: rest.slice(1).join(' ') });
      else out.push({ schedule: tok, user: null, command: rest.join(' ') });
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < (hasUser ? 7 : 6)) continue;
    const schedule = parts.slice(0, 5).join(' ');
    if (hasUser) out.push({ schedule, user: parts[5], command: parts.slice(6).join(' ') });
    else out.push({ schedule, user: null, command: parts.slice(5).join(' ') });
  }
  return out;
}

/** `systemctl list-timers --output=json` → [{unit, next, activates}] */
function parseTimers(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(t => ({
    unit: t.unit, next: t.next || null,
    left: t.left || null, last: t.last || null,
    activates: t.activates || null,
  }));
}

// --- sources ---------------------------------------------------------------

function safeRead(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }

async function collectJobs() {
  const jobs = [];
  const add = (source, text, hasUser) => {
    if (text == null) return;
    for (const j of parseCrontab(text, hasUser)) jobs.push({ source, ...j });
  };
  // root's (and current user's) crontab
  try { add('crontab', await run('crontab', ['-l']), false); } catch { /* none */ }
  add('/etc/crontab', safeRead('/etc/crontab'), true);
  try {
    for (const name of fs.readdirSync('/etc/cron.d')) {
      add('/etc/cron.d/' + name, safeRead(path.join('/etc/cron.d', name)), true);
    }
  } catch { /* no cron.d */ }
  return jobs;
}

async function collectTimers() {
  try {
    return parseTimers(await run('systemctl', ['list-timers', '--all', '--no-pager', '--output=json']));
  } catch { return []; }
}

async function detectDaemon() {
  for (const u of ['cron.service', 'crond.service', 'cronie.service']) {
    try { await run('systemctl', ['cat', u]); return u; } catch { /* not this one */ }
  }
  return null;
}

async function handleCron(ctx) {
  try {
    const jobs = await collectJobs();
    const timers = await collectTimers();
    const daemon = await detectDaemon();
    ctx.ok({ jobs, timers, daemon });
  } catch (e) { ctx.fail(e.message); }
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/cron', match: p => p[1] === 'sys' && p[2] === 'cron', handle: ctx => handleCron(ctx) },
];

module.exports = { routes, parseCrontab, parseTimers };

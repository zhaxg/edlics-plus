// users-api.js — users, groups and interactive sessions (read-only this pass).
//
// Sources: /etc/passwd, /etc/group, `who`. Parsers are pure/testable. Write
// operations (useradd/usermod/passwd …) are intentionally NOT exposed yet —
// they are the highest-consequence actions in the panel and need their own
// secure stdin/argv design + audit before landing (docs/ADMIN-PANEL-PLAN.md).
const fs = require('fs');
const { execFile } = require('child_process');

function run(file, args, timeout = 8000, maxBuffer = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

// --- pure parsers (exported for tests) -------------------------------------

/** /etc/passwd → [{name, uid, gid, gecos, home, shell, system}] */
function parsePasswd(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split(':');
    if (f.length < 7) continue;
    const uid = parseInt(f[2], 10);
    out.push({
      name: f[0], uid, gid: parseInt(f[3], 10),
      gecos: f[4].split(',')[0] || '', home: f[5], shell: f[6],
      system: uid < 1000,
    });
  }
  return out;
}

/** /etc/group → [{name, gid, members:[…]}] */
function parseGroup(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split(':');
    if (f.length < 4) continue;
    out.push({
      name: f[0], gid: parseInt(f[2], 10),
      members: f[3] ? f[3].split(',').filter(Boolean) : [],
    });
  }
  return out;
}

/** `who` → [{user, tty, from, since}]  (column layout varies across distros) */
function parseWho(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(/\s+/);
    const from = /\(([^)]*)\)/.exec(t);
    // the tty token is the first one that looks like a terminal (pts/1, tty1, :0)
    const ttyIdx = f.findIndex((x, i) => i > 0 && /^(pts\/|tty|:\d|\/dev\/)/.test(x));
    const ti = ttyIdx > 0 ? ttyIdx : 1;
    out.push({
      user: f[0], tty: f[ti] || '',
      since: f.slice(ti + 1, ti + 3).join(' ').trim(),
      from: from ? from[1] : '',
    });
  }
  return out;
}

/** Join users with their primary group name + supplementary memberships. */
function decorateUsers(users, groups) {
  const byGid = new Map(groups.map(g => [g.gid, g.name]));
  const supplementary = new Map();
  for (const g of groups) {
    for (const m of g.members) {
      if (!supplementary.has(m)) supplementary.set(m, []);
      supplementary.get(m).push(g.name);
    }
  }
  return users.map(u => ({
    ...u,
    group: byGid.get(u.gid) || String(u.gid),
    groups: supplementary.get(u.name) || [],
  }));
}

// --- handler ---------------------------------------------------------------

async function handleUsers(ctx) {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    const group = fs.readFileSync('/etc/group', 'utf-8');
    const groups = parseGroup(group);
    const users = decorateUsers(parsePasswd(passwd), groups);
    let sessions = [];
    try { sessions = parseWho(await run('who')); } catch { sessions = []; }
    ctx.ok({
      users,
      groups,
      sessions,
      counts: {
        users: users.length,
        system: users.filter(u => u.system).length,
        human: users.filter(u => !u.system).length,
        groups: groups.length,
      },
    });
  } catch (e) { ctx.fail(e.message); }
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/users', match: p => p[1] === 'sys' && p[2] === 'users', handle: ctx => handleUsers(ctx) },
];

module.exports = { routes, parsePasswd, parseGroup, parseWho, decorateUsers };

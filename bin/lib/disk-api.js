// disk-api.js — storage view: df (space + inodes), lsblk (block devices),
// findmnt (mount tree). Read-only; parsers are pure and testable.
const { execFile } = require('child_process');

function run(file, args, timeout = 10000, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

// --- pure parsers (exported for tests) -------------------------------------

/**
 * Parse `df -h` / `df -i` (POSIX output). Columns are generic; the UI labels
 * them (space vs inodes). Pure; tested.
 * @returns {{fs:string,size:string,used:string,avail:string,pct:string,mount:string}[]}
 */
function parseDf(text) {
  const out = [];
  const lines = String(text || '').split('\n').filter(l => l.trim());
  for (const line of lines.slice(1)) {           // skip header
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    out.push({ fs: f[0], size: f[1], used: f[2], avail: f[3], pct: f[4], mount: f.slice(5).join(' ') });
  }
  return out;
}

/** Flatten `lsblk -J` blockdevices (with depth). Pure; tested. */
function parseLsblk(text) {
  let root;
  try { root = JSON.parse(text); } catch { return []; }
  const out = [];
  const walk = (list, depth) => {
    for (const d of list || []) {
      out.push({
        name: d.name, type: d.type, size: d.size, fstype: d.fstype || '',
        mountpoint: d.mountpoint || '', ro: !!d.ro, tran: d.tran || '', model: d.model || '',
        depth,
      });
      if (d.children) walk(d.children, depth + 1);
    }
  };
  walk(root.blockdevices, 0);
  return out;
}

/** Flatten `findmnt -J` filesystems (with depth). Pure; tested. */
function parseFindmnt(text) {
  let root;
  try { root = JSON.parse(text); } catch { return []; }
  const out = [];
  const walk = (list, depth) => {
    for (const m of list || []) {
      out.push({
        target: m.target, source: m.source || '', fstype: m.fstype || '',
        size: m.size || '', used: m.used || '', avail: m.avail || '', usePct: m['use%'] || '',
        depth,
      });
      if (m.children) walk(m.children, depth + 1);
    }
  };
  walk(root.filesystems, 0);
  return out;
}

// --- handler ---------------------------------------------------------------

async function handleDisk(ctx) {
  const [h, i, ls, fm] = await Promise.all([
    run('df', ['-h', '-P']).catch(() => ''),
    run('df', ['-i', '-P']).catch(() => ''),
    run('lsblk', ['-J', '-o', 'NAME,KNAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,RO,TRAN,MODEL']).catch(() => ''),
    run('findmnt', ['-J', '-o', 'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%']).catch(() => ''),
  ]);
  ctx.ok({
    mounts: parseDf(h),
    inodes: parseDf(i),
    blockdevices: parseLsblk(ls),
    findmnt: parseFindmnt(fm),
  });
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed. */
const routes = [
  { name: 'api/sys/disk', match: p => p[1] === 'sys' && p[2] === 'disk', handle: ctx => handleDisk(ctx) },
];

module.exports = { routes, parseDf, parseLsblk, parseFindmnt };

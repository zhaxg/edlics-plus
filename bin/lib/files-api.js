// files-api.js — core file CRUD, stat, sudo elevation, server info.
// Every path from the client goes through ctx.checkPath (root containment).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getRootDir, detectFileType, toPosix } = require('./paths');
const { VERSION } = require('./version');

/**
 * @typedef {Object} FileInfo
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} mtime
 * @property {boolean} hidden
 */

// --- sudo elevation (password captured by api/sudo-auth) ---
let sudoPassword = null;

function sudoExec(cmd, password, cb) {
  const pw = password || sudoPassword;
  const full = pw
    ? `echo ${JSON.stringify(pw)} | sudo -S ${cmd} 2>/dev/null`
    : `sudo -n ${cmd} 2>/dev/null`;
  exec(full, { maxBuffer: 50 * 1024 * 1024 }, cb);
}

function sudoReadFile(filePath, password, cb) {
  sudoExec(`cat ${JSON.stringify(filePath)}`, password, (err, stdout) => {
    if (err) return cb(err);
    cb(null, stdout);
  });
}

function sudoWriteFile(filePath, content, password, cb) {
  const tmp = `/tmp/edlics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFile(tmp, content, 'utf-8', err => {
    if (err) return cb(err);
    sudoExec(`cp ${JSON.stringify(tmp)} ${JSON.stringify(filePath)}`, password, err => {
      fs.unlink(tmp, () => {});
      cb(err);
    });
  });
}

function hasSudoPassword() { return !!sudoPassword; }

function isDocker() {
  try { if (fs.existsSync('/.dockerenv')) return true; } catch {}
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (/docker|containerd/i.test(cgroup)) return true;
  } catch {}
  return false;
}

function handleList(ctx) {
  const { params, ok, fail, checkPath } = ctx;
  if (!checkPath(params.path)) return;
  fs.readdir(params.path, { withFileTypes: true }, (err, items) => {
    if (err) return fail(err.message);
    const result = [];
    let pending = items.length;
    if (pending === 0) return ok(result);
    for (const item of items) {
      fs.stat(path.join(params.path, item.name), (err, stat) => {
        if (!err) {
          result.push({
            name: item.name, isDirectory: item.isDirectory(),
            size: stat.size, mtime: stat.mtimeMs,
            hidden: item.name.startsWith('.'),
          });
        }
        if (--pending === 0) {
          result.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          ok(result);
        }
      });
    }
  });
}

function handleRead(ctx) {
  const { params, ok, fail, checkPath } = ctx;
  if (!checkPath(params.path)) return;
  fs.stat(params.path, (err, stat) => {
    if (err) return fail(err.message);
    if (stat.size > 50 * 1024 * 1024) return fail('File too large (>50MB)');
    // Read as raw Buffer first for accurate binary detection
    fs.readFile(params.path, (err, buf) => {
      if (err && err.code === 'EACCES' && (hasSudoPassword() || params.sudo === '1')) {
        return sudoReadFile(params.path, null, (err2, data) => {
          if (err2) return fail('Permission denied. Use sudo.');
          ok({ content: data, size: 0, mtime: 0, sudo: true });
        });
      }
      if (err && err.code === 'EACCES') return fail('Permission denied', 403);
      if (err) return fail(err.message);
      // Detect binary files: check first 512 bytes for null bytes
      let isBinary = false;
      const checkLen = Math.min(buf.length, 512);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) { isBinary = true; break; }
      }
      if (isBinary) {
        ok({ binary: true, size: stat.size, mtime: stat.mtimeMs, fileType: detectFileType(buf) });
      } else {
        const content = buf.toString('utf-8');
        ok({ content, size: stat.size, mtime: stat.mtimeMs });
      }
    });
  });
}

function handleWrite(ctx) {
  const { req, params, ok, fail, checkPath, checkReadonly } = ctx;
  if (checkReadonly()) return;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
    if (!checkPath(params.path)) return;
    fs.writeFile(params.path, data.content, 'utf-8', err => {
      if (err && err.code === 'EACCES' && (hasSudoPassword() || params.sudo === '1')) {
        return sudoWriteFile(params.path, data.content, null, err2 => {
          if (err2) return fail('Permission denied. Use sudo.');
          ok({ ok: true, sudo: true });
        });
      }
      if (err && err.code === 'EACCES') return fail('Permission denied', 403);
      if (err) return fail(err.message);
      ok({ ok: true });
    });
  });
}

function handleDelete(ctx) {
  const { params, ok, fail, checkPath, checkReadonly } = ctx;
  if (checkReadonly()) return;
  if (!checkPath(params.path)) return;
  fs.stat(params.path, (err, st) => {
    if (err) return fail(err.message);
    if (st.isDirectory()) {
      fs.rm(params.path, { recursive: true, force: true }, err => {
        if (err) return fail(err.message);
        ok({ ok: true });
      });
    } else {
      fs.unlink(params.path, err => {
        if (err) return fail(err.message);
        ok({ ok: true });
      });
    }
  });
}

function handleRename(ctx) {
  const { req, params, ok, fail, checkPath, checkReadonly } = ctx;
  if (checkReadonly()) return;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
    if (!checkPath(params.path) || !checkPath(data.newPath)) return;
    fs.rename(params.path, data.newPath, err => {
      if (err) return fail(err.message);
      ok({ ok: true });
    });
  });
}

function handleCreate(ctx) {
  const { req, params, ok, fail, checkPath, checkReadonly } = ctx;
  if (checkReadonly()) return;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
    if (!checkPath(params.path)) return;
    if (data.type === 'directory') {
      fs.mkdir(params.path, { recursive: true }, err => err ? fail(err.message) : ok({ ok: true }));
    } else {
      fs.writeFile(params.path, data.content || '', 'utf-8', err => err ? fail(err.message) : ok({ ok: true }));
    }
  });
}

function handleStat(ctx) {
  const { params, ok, fail, checkPath } = ctx;
  if (!checkPath(params.path)) return;
  fs.stat(params.path, (err, stat) => {
    if (err) return fail(err.message);
    ok({ name: path.basename(params.path), isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
  });
}

function handleSudoStatus(ctx) {
  exec('sudo -n true 2>/dev/null', err => {
    ctx.ok({ nopasswd: !err });
  });
}

function handleSudoAuth(ctx) {
  const { req, ok, fail } = ctx;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
    if (!data.password) return fail('Password required');
    exec(`echo ${JSON.stringify(data.password)} | sudo -S true 2>/dev/null`, err => {
      if (err) return fail('Wrong password');
      sudoPassword = data.password;
      ok({ ok: true });
    });
  });
}

function handleInfo(ctx) {
  const { ok, readonly } = ctx;
  const docker = isDocker();
  let user;
  if (docker) {
    user = 'docker';
  } else {
    user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
  }
  const rootDir = getRootDir();
  const homeDir = rootDir || (process.env.SUDO_USER
    ? path.resolve('/home', process.env.SUDO_USER)
    : os.homedir());
  let ip = '127.0.0.1';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
      }
    }
  } catch {}
  ok({ user, hostname: os.hostname(), ip, home: toPosix(homeDir), root: !!rootDir, readonly, docker, terminal: !!ctx.terminal, version: VERSION });
}

/** Route table — see CLAUDE.md. `parts[0] === 'api'` is guaranteed by the dispatcher. */
const routes = [
  { name: 'api/list',        match: (p, q) => p[1] === 'list' && !!q.path,        handle: handleList },
  { name: 'api/read',        match: (p, q) => p[1] === 'read' && !!q.path,        handle: handleRead },
  { name: 'api/write',       match: p => p[1] === 'write',                          handle: handleWrite },
  { name: 'api/delete',      match: (p, q) => p[1] === 'delete' && !!q.path,      handle: handleDelete },
  { name: 'api/rename',      match: (p, q) => p[1] === 'rename' && !!q.path,      handle: handleRename },
  { name: 'api/create',      match: (p, q) => p[1] === 'create' && !!q.path,      handle: handleCreate },
  { name: 'api/stat',        match: (p, q) => p[1] === 'stat' && !!q.path,        handle: handleStat },
  { name: 'api/sudo-status', match: p => p[1] === 'sudo-status',                    handle: handleSudoStatus },
  { name: 'api/sudo-auth',   match: p => p[1] === 'sudo-auth',                      handle: handleSudoAuth },
  { name: 'api/info',        match: p => p[1] === 'info',                           handle: handleInfo },
];

module.exports = { routes, sudoReadFile, sudoWriteFile, hasSudoPassword };

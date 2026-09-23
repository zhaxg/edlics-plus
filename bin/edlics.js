#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { exec, execFile } = require('child_process');

let sudoPassword = null;
let rootDir = null; // When set, all file operations are restricted to this directory
let readonly = false; // When true, all write operations are blocked

// --- Auth: every /api/* route requires a session cookie except login/session/logout ---
let authPasswordHash = null; // sha256 Buffer (32 bytes) for timing-safe compare
const sessions = new Map();      // token -> expiry epoch ms
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 days
const MAX_LOGIN_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).edlics_session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function pruneSessions() {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}

// Terminal (node-pty) state — one real TTY shell per logged-in session,
// wede-style: the shell itself does echo/line-editing/tab-stops over the PTY;
// the browser only passes raw keystrokes through.
const termSessions = new Map(); // session token -> { pty, parts, len, stream, exited }
let _pty = null;
function getPty() {
  if (!_pty) _pty = require('node-pty');
  return _pty;
}
function termKey(req) { return parseCookies(req).edlics_session || 'anon'; }
process.on('exit', () => {
  for (const s of termSessions.values()) { try { s.pty.kill(); } catch {} }
});

// Cross-platform containment check: target is base itself or a descendant.
// path.relative handles OS separators and Windows case-insensitivity,
// unlike prefixing with '/' which breaks on Windows (rootDir + '/' never matches '\').
function isWithinRoot(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function isPathSafe(targetPath) {
  if (!rootDir) return true;
  const resolved = path.resolve(targetPath);
  if (!isWithinRoot(rootDir, resolved)) return false;
  // Resolve symlinks to prevent escape via symlink traversal
  try {
    const real = fs.realpathSync(resolved);
    return isWithinRoot(rootDir, real);
  } catch {
    // Path doesn't exist yet (e.g. create) — check parent for symlink escape
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      const reassembled = path.join(realParent, path.basename(resolved));
      return isWithinRoot(rootDir, reassembled);
    } catch {
      return false;
    }
  }
}

function detectFileType(buf) {
  if (buf.length < 4) return 'Unknown file';
  // ELF
  if (buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) {
    const arch = buf.length > 4 ? buf[4] : 0;
    const bits = arch === 1 ? '32-bit' : arch === 2 ? '64-bit' : '';
    return 'ELF executable' + (bits ? ' (' + bits + ')' : '');
  }
  // PE / EXE
  if (buf[0] === 0x4D && buf[1] === 0x5A) return 'Windows executable (PE)';
  // Mach-O
  if ((buf[0] === 0xFE && buf[1] === 0xED && buf[2] === 0xFA) ||
      (buf[0] === 0xCE && buf[1] === 0xFA && buf[2] === 0xED)) return 'Mach-O executable';
  // ZIP / JAR / APK
  if (buf[0] === 0x50 && buf[1] === 0x4B) {
    if (buf.length > 4 && buf[2] === 0x03 && buf[3] === 0x04) return 'ZIP archive';
    return 'ZIP archive';
  }
  // GZIP
  if (buf[0] === 0x1F && buf[1] === 0x8B) return 'GZIP archive';
  // BZ2
  if (buf[0] === 0x42 && buf[1] === 0x5A && buf[2] === 0x68) return 'BZ2 archive';
  // XZ
  if (buf[0] === 0xFD && buf[1] === 0x37 && buf[2] === 0x7A && buf[3] === 0x58) return 'XZ archive';
  // 7z
  if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z archive';
  // RAR
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'RAR archive';
  // PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'PDF document';
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'PNG image';
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'JPEG image';
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'GIF image';
  // WebP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'WebP image';
  // MP3
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'MP3 audio';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'MP3 audio';
  // OGG
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67) return 'OGG audio';
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return 'FLAC audio';
  // MP4
  if (buf.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'MP4 video';
  // SQLite
  if (buf[0] === 0x53 && buf[1] === 0x51 && buf[2] === 0x4C && buf[3] === 0x69) return 'SQLite database';
  // ISO 9660
  if (buf.length > 0x8001 && buf[0x8001] === 0x43 && buf[0x8002] === 0x44) return 'ISO image';
  // Docker image
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00) return 'Binary data';
  // Generic fallback
  return 'Binary file';
}

function sudoExec(cmd, password, cb) {
  const pw = password || sudoPassword;
  const full = pw
    ? `echo ${JSON.stringify(pw)} | sudo -S ${cmd} 2>/dev/null`
    : `sudo -n ${cmd} 2>/dev/null`;
  exec(full, { maxBuffer: 50 * 1024 * 1024 }, cb);
}

// Smart directory filtering: detect project type and exclude build/cache dirs
const BASE_EXCLUDE = new Set(['.git', '.svn', '.hg', '.DS_Store']);
const PROJECT_EXCLUDES = {
  'package.json':   ['node_modules', 'dist', '.next', '.nuxt', '.cache', '.turbo'],
  'go.mod':         ['vendor'],
  'pom.xml':        ['target'],
  'build.gradle':   ['target', '.gradle'],
  'Cargo.toml':     ['target'],
  'requirements.txt': ['__pycache__', '.venv', 'venv', '.mypy_cache', '.tox'],
  'pyproject.toml': ['__pycache__', '.venv', 'venv', '.mypy_cache', '.tox'],
  'Gemfile':        ['vendor', '.bundle'],
  '.csproj':        ['bin', 'obj', '.vs', 'packages'],
  '.sln':           ['bin', 'obj', '.vs', 'packages'],
  '.slnx':          ['bin', 'obj', '.vs', 'packages'],
};

function getExcludes(dirPath) {
  const excluded = new Set(BASE_EXCLUDE);
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { return excluded; }
  for (const marker of Object.keys(PROJECT_EXCLUDES)) {
    if (marker.startsWith('.')) {
      // dot-files: check exact match (e.g. .sln won't work as startsWith, use some)
      if (entries.some(e => e === marker || e.endsWith(marker))) {
        for (const d of PROJECT_EXCLUDES[marker]) excluded.add(d);
      }
    } else {
      if (entries.includes(marker)) {
        for (const d of PROJECT_EXCLUDES[marker]) excluded.add(d);
      }
    }
  }
  return excluded;
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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

// Version: prefer git tag, fallback to package.json
let _version = pkg.version;
try {
  const { execSync } = require('child_process');
  const tag = execSync('git describe --tags --abbrev=0 2>/dev/null', {
    cwd: path.join(__dirname, '..'), encoding: 'utf-8', timeout: 2000
  }).trim();
  if (tag) _version = tag.replace(/^v/, '');
} catch {}
const VERSION = _version;
const MIME = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function isDocker() {
  try { if (fs.existsSync('/.dockerenv')) return true; } catch {}
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (/docker|containerd/i.test(cgroup)) return true;
  } catch {}
  return false;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = { hostname: '127.0.0.1', port: 3000, root: null, readonly: false, password: null };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hostname' && args[i + 1]) opts.hostname = args[++i];
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === '--root' && args[i + 1]) opts.root = args[++i];
    if (args[i] === '--password' && args[i + 1]) opts.password = args[++i];
    if (args[i] === '--readonly') opts.readonly = true;
  }
  return { cmd, opts };
}

// Static files: ETag conditional caching (304 on revalidate) + gzip for text assets.
const GZIP_EXTS = new Set(['.mjs', '.js', '.css', '.html', '.json', '.svg', '.map', '.txt']);
function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    // Conditional request → cheap 304 (browser reuses cached body)
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some(t => t.trim() === etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const headers = {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': 'no-cache', // may be stored, must revalidate → 304 when unchanged
      Vary: 'Accept-Encoding',
    };
    const acceptGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (acceptGzip && GZIP_EXTS.has(ext) && stat.size > 1024) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      const src = fs.createReadStream(filePath);
      const zip = zlib.createGzip({ level: 6 });
      const bail = () => { try { res.end(); } catch {} };
      src.on('error', bail);
      zip.on('error', bail);
      src.pipe(zip).pipe(res);
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    const src = fs.createReadStream(filePath);
    src.on('error', () => { try { res.end(); } catch {} });
    src.pipe(res);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

function handleAPI(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = u.pathname.split('/').filter(Boolean);
  const params = Object.fromEntries(u.searchParams);

  function ok(data) { json(res, data); }
  function fail(msg, code) { error(res, msg, code || 500); }
  function checkReadonly() {
    if (readonly) { fail('Server is in read-only mode', 403); return true; }
    return false;
  }

  try {
    // --- Auth routes (public) ---
    if (parts[0] === 'api' && parts[1] === 'session') {
      return ok({ authenticated: isAuthed(req) });
    }

    if (parts[0] === 'api' && parts[1] === 'login') {
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip);
      if (attempt && attempt.lockedUntil > Date.now()) {
        return fail('Too many failed attempts. Try again later.', 429);
      }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) { req.destroy(); } });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { return fail('Invalid JSON', 400); }
        const given = sha256(data.password || '');
        const pass = authPasswordHash && given.length === authPasswordHash.length &&
          crypto.timingSafeEqual(given, authPasswordHash);
        if (!pass) {
          const a = attempt || { fails: 0, lockedUntil: 0 };
          a.fails++;
          if (a.fails >= MAX_LOGIN_FAILS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.fails = 0; }
          loginAttempts.set(ip, a);
          return fail('Wrong password', 401);
        }
        loginAttempts.delete(ip);
        pruneSessions();
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL);
        res.setHeader('Set-Cookie', `edlics_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
        return ok({ ok: true });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'logout') {
      const token = parseCookies(req).edlics_session;
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'edlics_session=; HttpOnly; Path=/; Max-Age=0');
      return ok({ ok: true });
    }

    // --- Everything below requires an authenticated session ---
    if (!isAuthed(req)) return fail('Unauthorized', 401);

    // Helper: fail if the resolved path is outside the root directory
    function checkPath(p) {
      if (!isPathSafe(p)) { fail('Access denied: path outside root directory', 403); return false; }
      return true;
    }

    if (parts[0] === 'api' && parts[1] === 'list' && params.path) {
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
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'read' && params.path) {
      if (!checkPath(params.path)) return;
      fs.stat(params.path, (err, stat) => {
        if (err) return fail(err.message);
        if (stat.size > 50 * 1024 * 1024) return fail('File too large (>50MB)');
        // Read as raw Buffer first for accurate binary detection
        fs.readFile(params.path, (err, buf) => {
          if (err && err.code === 'EACCES' && (sudoPassword || params.sudo === '1')) {
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
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'write') {
      if (checkReadonly()) return;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (!checkPath(params.path)) return;
        fs.writeFile(params.path, data.content, 'utf-8', err => {
          if (err && err.code === 'EACCES' && (sudoPassword || params.sudo === '1')) {
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
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'delete' && params.path) {
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
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'rename' && params.path) {
      if (checkReadonly()) return;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (!checkPath(params.path) || !checkPath(data.newPath)) return;
        fs.rename(params.path, data.newPath, err => {
          if (err) return fail(err.message);
          ok({ ok: true });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'create' && params.path) {
      if (checkReadonly()) return;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (!checkPath(params.path)) return;
        if (data.type === 'directory') {
          fs.mkdir(params.path, { recursive: true }, err => err ? fail(err.message) : ok({ ok: true }));
        } else {
          fs.writeFile(params.path, data.content || '', 'utf-8', err => err ? fail(err.message) : ok({ ok: true }));
        }
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'stat' && params.path) {
      if (!checkPath(params.path)) return;
      fs.stat(params.path, (err, stat) => {
        if (err) return fail(err.message);
        ok({ name: path.basename(params.path), isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'sudo-status') {
      exec('sudo -n true 2>/dev/null', err => {
        ok({ nopasswd: !err });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'sudo-auth') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (!data.password) return fail('Password required');
        exec(`echo ${JSON.stringify(data.password)} | sudo -S true 2>/dev/null`, err => {
          if (err) return fail('Wrong password');
          sudoPassword = data.password;
          ok({ ok: true });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'info') {
      const os = require('os');
      const docker = isDocker();
      let user;
      if (docker) {
        user = 'docker';
      } else {
        user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
      }
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
      ok({ user, hostname: os.hostname(), ip, home: homeDir, root: !!rootDir, readonly, docker, version: VERSION });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'search') {
      const searchPath = params.path || (rootDir || '/');
      if (!checkPath(searchPath)) return;
      const results = [];
      function walk(dir, cb) {
        const excluded = getExcludes(dir);
        fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
          if (err) return cb();
          let pending = entries.length;
          if (pending === 0) return cb();
          for (const e of entries) {
            if (e.name.startsWith('.') || excluded.has(e.name)) { if (--pending === 0) cb(); continue; }
            const full = path.join(dir, e.name);
            if (full.length > 4096) { if (--pending === 0) cb(); continue; }
            if (results.length >= 200) { if (--pending === 0) cb(); continue; }
            if (e.name.toLowerCase().includes((params.q || '').toLowerCase())) results.push(full);
            if (e.isDirectory()) {
              walk(full, () => { if (--pending === 0) cb(); });
            } else {
              if (--pending === 0) cb();
            }
          }
        });
      }
      walk(searchPath, () => ok(results));
      return;
    }

    // Full-text content search: returns [{ path, line, column, text }] grouped downstream
    if (parts[0] === 'api' && parts[1] === 'search-content') {
      const searchPath = params.path || (rootDir || '/');
      if (!checkPath(searchPath)) return;
      const q = params.q || '';
      if (!q) return ok([]);
      const caseSensitive = params.case === '1';
      const needle = caseSensitive ? q : q.toLowerCase();
      const results = [];
      const MAX_RESULTS = 500;
      const MAX_FILE_SIZE = 2 * 1024 * 1024; // skip files > 2MB
      let done = false;

      function searchFile(filePath) {
        if (done) return;
        let buf;
        try { buf = fs.readFileSync(filePath); } catch { return; }
        if (buf.length > MAX_FILE_SIZE) return;
        // Skip binary (null byte in first 8KB)
        const probe = Math.min(buf.length, 8192);
        for (let i = 0; i < probe; i++) if (buf[i] === 0) return;
        const content = buf.toString('utf-8');
        const hay = caseSensitive ? content : content.toLowerCase();
        if (!hay.includes(needle)) return;
        const lines = content.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const lineText = lines[li];
          const hayLine = caseSensitive ? lineText : lineText.toLowerCase();
          let from = 0; let col;
          while ((col = hayLine.indexOf(needle, from)) !== -1) {
            results.push({ path: filePath, line: li + 1, column: col + 1, text: lineText.slice(0, 300) });
            if (results.length >= MAX_RESULTS) { done = true; return; }
            from = col + needle.length;
            if (needle.length === 0) break;
          }
        }
      }

      function walk(dir, cb) {
        if (done) return cb();
        const excluded = getExcludes(dir);
        fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
          if (err) return cb();
          let pending = entries.length;
          if (pending === 0) return cb();
          for (const ent of entries) {
            if (ent.name.startsWith('.') || excluded.has(ent.name)) { if (--pending === 0) cb(); continue; }
            const full = path.join(dir, ent.name);
            if (full.length > 4096) { if (--pending === 0) cb(); continue; }
            if (done) { if (--pending === 0) cb(); continue; }
            if (ent.isDirectory()) {
              walk(full, () => { if (--pending === 0) cb(); });
            } else {
              searchFile(full);
              if (--pending === 0) cb();
            }
          }
        });
      }

      fs.stat(searchPath, (err, stat) => {
        if (err) return fail(err.message);
        if (stat.isFile()) { searchFile(searchPath); return ok(results); }
        walk(searchPath, () => ok(results));
      });
      return;
    }

    // ---------- Git API (read-only; all commands run with cwd=workspace, no shell) ----------
    function gitWorkspace() {
      const ws = params.path;
      if (!ws) return null;
      if (!isPathSafe(ws)) return null;
      try { if (!fs.statSync(ws).isDirectory()) return null; } catch { return null; }
      return ws;
    }
    function gitRun(ws, args, cb) {
      execFile('git', args, {
        cwd: ws, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString().trim().slice(0, 500);
          return cb(null, { ok: false, error: msg || 'git command failed' });
        }
        cb(null, { ok: true, out: stdout });
      });
    }

    if (parts[0] === 'api' && parts[1] === 'git' && parts[2] === 'status') {
      const ws = gitWorkspace();
      if (!ws) return fail('Invalid workspace', 400);
      gitRun(ws, ['status', '--porcelain=v1', '-z', '-b'], (e, r) => {
        if (!r.ok) return ok({ repo: false, error: r.error });
        // -z output: first NUL-terminated field is the "## branch" header, rest are entries
        const chunks = r.out.split('\0');
        const header = chunks[0] || '';
        let branch = 'HEAD';
        const m = header.match(/^##\s+(?:No commits yet on|Initial commit on)\s+(\S+)/);
        if (m) branch = m[1];
        else {
          branch = header.replace(/^##\s*/, '').split('...')[0].split(' ')[0] || 'HEAD';
        }
        const changes = [];
        for (let i = 1; i < chunks.length; i++) {
          const entry = chunks[i];
          if (!entry) continue;
          const xy = entry.slice(0, 2);
          let file = entry.slice(3);
          // Renames/copies in -z: entry holds the new path; the next field is the old path
          if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') && i + 1 < chunks.length) {
            i++;
          }
          if (file) changes.push({ xy, path: file });
        }
        ok({ repo: true, branch, changes });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'git' && parts[2] === 'log') {
      const ws = gitWorkspace();
      if (!ws) return fail('Invalid workspace', 400);
      const n = Math.min(parseInt(params.n) || 50, 200);
      gitRun(ws, ['log', '-n', String(n), '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'], (e, r) => {
        if (!r.ok) return ok({ repo: false, error: r.error, commits: [] });
        const commits = r.out.split('\n').filter(Boolean).map(line => {
          const [hash, short, author, date, ...subject] = line.split('\x1f');
          return { hash, short, author, date, subject: subject.join('\x1f') };
        });
        ok({ repo: true, commits });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'git' && parts[2] === 'commit-files') {
      const ws = gitWorkspace();
      if (!ws) return fail('Invalid workspace', 400);
      const sha = params.sha || '';
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) return fail('Invalid commit sha', 400);
      gitRun(ws, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', sha], (e, r) => {
        if (!r.ok) return ok({ repo: false, error: r.error, files: [] });
        const chunks = r.out.split('\0').filter(Boolean);
        const files = [];
        for (let i = 0; i < chunks.length; i++) {
          const status = chunks[i];
          if (!/^[AMDRTC]\d?$/.test(status)) continue;
          const file = chunks[++i];
          if (file) files.push({ status: status[0], path: file });
        }
        ok({ repo: true, files });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'git' && parts[2] === 'diff') {
      const ws = gitWorkspace();
      if (!ws) return fail('Invalid workspace', 400);
      const file = params.file;
      if (!file) return fail('file required', 400);
      const args = ['diff', '--no-color'];
      if (params.staged === '1') args.push('--cached');
      args.push('--', file);
      gitRun(ws, args, (e, r) => {
        if (!r.ok) return fail(r.error, 500);
        ok({ diff: r.out });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'git' && parts[2] === 'show') {
      const ws = gitWorkspace();
      if (!ws) return fail('Invalid workspace', 400);
      const sha = params.sha || '';
      const file = params.file;
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) return fail('Invalid commit sha', 400);
      if (!file) return fail('file required', 400);
      gitRun(ws, ['show', '--no-color', '--format=', sha, '--', file], (e, r) => {
        if (!r.ok) return fail(r.error, 500);
        ok({ diff: r.out });
      });
      return;
    }

    // ---------- Terminal (node-pty — real TTY; wede-style, xterm passes raw keys) ----------
    function termKeyOf(req) { return termKey(req); }
    function termBufAppend(sess, data) {
      sess.parts.push(data);
      sess.len += data.length;
      while (sess.len > 256 * 1024 && sess.parts.length > 1) sess.len -= sess.parts.shift().length;
    }
    function readJsonBody(req, cb, max = 64 * 1024) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body || '{}'); } catch { return cb(null); }
        cb(data);
      });
    }

    if (parts[0] === 'api' && parts[1] === 'term' && parts[2] === 'open') {
      return readJsonBody(req, data => {
        if (!data) return fail('Invalid JSON', 400);
        const key = termKeyOf(req);
        const existing = termSessions.get(key);
        if (existing) {
          if (existing.stream && !existing.stream.writableEnded) { try { existing.stream.end(); } catch {} }
          try { existing.pty.kill(); } catch {}
          termSessions.delete(key);
        }

        let cwd = data.cwd || rootDir || process.cwd();
        if (!isPathSafe(cwd)) return fail('Access denied: path outside root directory', 403);
        try { if (!fs.statSync(cwd).isDirectory()) cwd = rootDir || process.cwd(); }
        catch { cwd = rootDir || process.cwd(); }

        const cols = Math.min(500, Math.max(20, parseInt(data.cols) || 80));
        const rows = Math.min(200, Math.max(5, parseInt(data.rows) || 24));
        const isWin = process.platform === 'win32';
        const file = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');

        let pty;
        try {
          pty = getPty().spawn(file, [], {
            name: 'xterm-256color', cols, rows, cwd,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
        } catch (e) { return fail('Failed to start shell: ' + e.message, 500); }

        const sess = { pty, parts: [], len: 0, stream: null, exited: false, cwd };
        termSessions.set(key, sess);
        pty.onData(d => {
          termBufAppend(sess, d);
          if (sess.stream && !sess.stream.writableEnded) sess.stream.write(d);
        });
        pty.onExit(() => {
          sess.exited = true;
          if (termSessions.get(key) === sess) termSessions.delete(key);
          if (sess.stream && !sess.stream.writableEnded) {
            try { sess.stream.write('\r\n[process exited]\r\n'); sess.stream.end(); } catch {}
          }
        });
        return ok({ ok: true, cwd });
      });
    }

    if (parts[0] === 'api' && parts[1] === 'term' && parts[2] === 'stream') {
      const sess = termSessions.get(termKeyOf(req));
      if (!sess || sess.exited) return fail('No terminal session', 410);
      // Single viewer: a new stream takes over from any previous one
      if (sess.stream && !sess.stream.writableEnded) { try { sess.stream.end(); } catch {} }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      for (const chunk of sess.parts) res.write(chunk);
      sess.stream = res;
      res.on('close', () => { if (sess.stream === res) sess.stream = null; });
      return; // stays open, fed by pty.onData above
    }

    if (parts[0] === 'api' && parts[1] === 'term' && parts[2] === 'input') {
      return readJsonBody(req, data => {
        if (!data) return fail('Invalid JSON', 400);
        const sess = termSessions.get(termKeyOf(req));
        if (!sess || sess.exited) return fail('No terminal session', 410);
        if (typeof data.data === 'string' && data.data) { try { sess.pty.write(data.data); } catch {} }
        return ok({ ok: true });
      });
    }

    if (parts[0] === 'api' && parts[1] === 'term' && parts[2] === 'resize') {
      return readJsonBody(req, data => {
        if (!data) return fail('Invalid JSON', 400);
        const sess = termSessions.get(termKeyOf(req));
        if (!sess || sess.exited) return fail('No terminal session', 410);
        const cols = Math.min(500, Math.max(20, parseInt(data.cols) || 80));
        const rows = Math.min(200, Math.max(5, parseInt(data.rows) || 24));
        try { sess.pty.resize(cols, rows); } catch {}
        return ok({ ok: true });
      }, 1024);
    }

    if (parts[0] === 'api' && parts[1] === 'term' && parts[2] === 'close') {
      const key = termKeyOf(req);
      const sess = termSessions.get(key);
      if (sess) {
        if (sess.stream && !sess.stream.writableEnded) { try { sess.stream.end(); } catch {} }
        try { sess.pty.kill(); } catch {}
        termSessions.delete(key);
      }
      return ok({ ok: true });
    }

    if (parts[0] === 'api' && parts[1] === 'download' && params.path) {
      if (!checkPath(params.path)) return;
      fs.stat(params.path, (err, stat) => {
        if (err) return fail(err.message);
        const fileName = path.basename(params.path);
        if (stat.isDirectory()) {
          const parentDir = path.dirname(params.path);
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${fileName}.tar.gz"`,
            'Cache-Control': 'no-cache',
          });
          const tar = exec(`tar -czf - -C ${JSON.stringify(parentDir)} ${JSON.stringify(fileName)}`, { maxBuffer: 1024 * 1024 * 1024 });
          tar.stdout.pipe(res);
          tar.stderr.on('data', () => {});
          tar.on('error', () => { res.end(); });
          return;
        }
        const contentType = MIME[path.extname(params.path)] || 'application/octet-stream';
        fs.access(params.path, fs.R_OK, err => {
          if (err && err.code === 'EACCES' && (sudoPassword || params.sudo === '1')) {
            const pw = params.sudo === '1' ? null : undefined;
            return sudoReadFile(params.path, pw, (err2, data) => {
              if (err2) return fail('Permission denied. Use sudo.');
              const buf = Buffer.from(data, 'utf-8');
              res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Length': buf.length,
                'Cache-Control': 'no-cache',
              });
              res.end(buf);
            });
          }
          const rStream = fs.createReadStream(params.path);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
          });
          rStream.pipe(res);
          rStream.on('error', () => { if (!res.writableEnded) res.end(); });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'upload' && params.path) {
      if (checkReadonly()) return;
      if (!checkPath(params.path)) return;
      let body = '';
      req.on('data', c => { body += c; if (body.length > 55 * 1024 * 1024) { req.destroy(); } });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { return fail('Invalid JSON'); }
        const buf = Buffer.from(data.content || '', 'base64');
        if (buf.length > 50 * 1024 * 1024) return fail('File too large (>50MB)');
        fs.writeFile(params.path, buf, err => {
          if (err && err.code === 'EACCES' && (sudoPassword || params.sudo === '1')) {
            return sudoWriteFile(params.path, buf.toString('utf-8'), null, err2 => {
              if (err2) return fail('Permission denied. Use sudo.');
              ok({ ok: true, sudo: true });
            });
          }
          if (err && err.code === 'EACCES') return fail('Permission denied', 403);
          if (err) return fail(err.message);
          ok({ ok: true, size: buf.length });
        });
      });
      return;
    }

    fail('Not found', 404);
  } catch (e) {
    fail(e.message);
  }
}

function router(req, res) {
  if (req.url.startsWith('/api/')) {
    return handleAPI(req, res);
  }
  const urlPath = req.url.split('?')[0];
  let filePath = path.resolve(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  // Containment: never serve anything outside public/ (blocks /../ traversal)
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      serveStatic(req, res, filePath);
    } else {
      serveStatic(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
  });
}

function startServer(opts) {
  readonly = opts.readonly;

  // Password: --password flag > EDLICS_PASSWORD env > auto-generated (printed once)
  let password = opts.password || process.env.EDLICS_PASSWORD;
  let generatedPassword = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generatedPassword = true;
  }
  authPasswordHash = sha256(password);

  if (opts.root) {
    rootDir = path.resolve(opts.root);
    if (!fs.existsSync(rootDir)) {
      console.error(`\n  Error: root directory does not exist: ${rootDir}\n`);
      process.exit(1);
    }
    if (!fs.statSync(rootDir).isDirectory()) {
      console.error(`\n  Error: root path is not a directory: ${rootDir}\n`);
      process.exit(1);
    }
  }

  const server = http.createServer(router);
  server.listen(opts.port, opts.hostname, () => {
    console.log(`\n  Edlics running at:`);
    console.log(`  Local:   http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${opts.port}`);
    if (generatedPassword) {
      console.log(`  Password: ${password}  (auto-generated — set --password or EDLICS_PASSWORD to choose your own)`);
    }
    if (rootDir) {
      console.log(`  Root:    ${rootDir}`);
    }
    if (opts.hostname === '0.0.0.0') {
      const os = require('os');
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log(`  Network: http://${iface.address}:${opts.port}`);
          }
        }
      }
    }
    console.log();
  });
}

const { cmd, opts } = parseArgs();

if (cmd === 'serve') {
  startServer(opts);
} else {
  console.log(`
  Edlics - Web File Browser & Editor

  Usage:
    edlics serve [options]

  Options:
    --hostname   Host to bind to (default: 127.0.0.1)
    --port       Port to listen on (default: 3000)
    --root       Root directory to restrict file operations (default: no restriction)
    --password   Login password (or set EDLICS_PASSWORD; auto-generated if omitted)
    --readonly   Enable read-only mode — blocks all write operations

  Examples:
    edlics serve
    edlics serve --hostname 0.0.0.0 --port 5000 --password secret
    edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www
  `);
}

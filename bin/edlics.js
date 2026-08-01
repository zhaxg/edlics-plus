#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

let sudoPassword = null;
let rootDir = null; // When set, all file operations are restricted to this directory
let readonly = false; // When true, all write operations are blocked

function isPathSafe(targetPath) {
  if (!rootDir) return true;
  const resolved = path.resolve(targetPath);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + '/')) return false;
  // Resolve symlinks to prevent escape via symlink traversal
  try {
    const real = fs.realpathSync(resolved);
    return real === rootDir || real.startsWith(rootDir + '/');
  } catch {
    // Path doesn't exist yet (e.g. create) — check parent for symlink escape
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      const reassembled = path.join(realParent, path.basename(resolved));
      return reassembled === rootDir || reassembled.startsWith(rootDir + '/');
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

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = { hostname: '127.0.0.1', port: 3000, root: null, readonly: false };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hostname' && args[i + 1]) opts.hostname = args[++i];
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === '--root' && args[i + 1]) opts.root = args[++i];
    if (args[i] === '--readonly') opts.readonly = true;
  }
  return { cmd, opts };
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(data);
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
      const user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
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
      ok({ user, hostname: os.hostname(), ip, home: homeDir, root: !!rootDir, readonly });
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
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      serveStatic(res, filePath);
    } else {
      serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
  });
}

function startServer(opts) {
  readonly = opts.readonly;
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
    --readonly   Enable read-only mode — blocks all write operations

  Examples:
    edlics serve
    edlics serve --hostname 0.0.0.0 --port 5000
    edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www
  `);
}

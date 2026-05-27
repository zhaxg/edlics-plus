#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

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
  const opts = { hostname: '127.0.0.1', port: 3000 };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hostname' && args[i + 1]) opts.hostname = args[++i];
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i]);
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

  try {
    if (parts[0] === 'api' && parts[1] === 'list' && params.path) {
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
      fs.stat(params.path, (err, stat) => {
        if (err) return fail(err.message);
        if (stat.size > 50 * 1024 * 1024) return fail('File too large (>50MB)');
        fs.readFile(params.path, 'utf-8', (err, content) => {
          if (err && err.code === 'EACCES' && (sudoPassword || params.sudo === '1')) {
            return sudoReadFile(params.path, null, (err2, data) => {
              if (err2) return fail('Permission denied. Use sudo.');
              ok({ content: data, size: 0, mtime: 0, sudo: true });
            });
          }
          if (err && err.code === 'EACCES') return fail('Permission denied', 403);
          if (err) return fail(err.message);
          ok({ content, size: stat.size, mtime: stat.mtimeMs });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'write') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
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
      fs.stat(params.path, (err, st) => {
        if (err) return fail(err.message);
        const rm = st.isDirectory() ? fs.rm : fs.unlink;
        rm(params.path, { recursive: true, force: true }, err => {
          if (err) return fail(err.message);
          ok({ ok: true });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'rename' && params.path) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        fs.rename(params.path, data.newPath, err => {
          if (err) return fail(err.message);
          ok({ ok: true });
        });
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'create' && params.path) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (data.type === 'directory') {
          fs.mkdir(params.path, { recursive: true }, err => err ? fail(err.message) : ok({ ok: true }));
        } else {
          fs.writeFile(params.path, data.content || '', 'utf-8', err => err ? fail(err.message) : ok({ ok: true }));
        }
      });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'stat' && params.path) {
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
      const homeDir = process.env.SUDO_USER
        ? path.resolve('/home', process.env.SUDO_USER)
        : os.homedir();
      let ip = '127.0.0.1';
      try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
          }
        }
      } catch {}
      ok({ user, hostname: os.hostname(), ip, home: homeDir });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'search') {
      const results = [];
      function walk(dir, cb) {
        fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
          if (err) return cb();
          let pending = entries.length;
          if (pending === 0) return cb();
          for (const e of entries) {
            if (e.name.startsWith('.')) { if (--pending === 0) cb(); continue; }
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
      walk(params.path || '/', () => ok(results));
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'download' && params.path) {
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
  const server = http.createServer(router);
  server.listen(opts.port, opts.hostname, () => {
    console.log(`\n  Edlics running at:`);
    console.log(`  Local:   http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${opts.port}`);
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

  Examples:
    edlics serve
    edlics serve --hostname 0.0.0.0 --port 3000
  `);
}

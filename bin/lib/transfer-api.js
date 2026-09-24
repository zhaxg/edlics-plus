// transfer-api.js — download (incl. tar.gz folders) and upload endpoints.
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { MIME } = require('./static');
const { sudoReadFile, sudoWriteFile, hasSudoPassword } = require('./files-api');

function handleDownload(ctx) {
  const { req, res, params, fail, checkPath } = ctx;
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
      if (err && err.code === 'EACCES' && (hasSudoPassword() || params.sudo === '1')) {
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
}

function handleUpload(ctx) {
  const { req, params, ok, fail, checkPath, checkReadonly } = ctx;
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
      if (err && err.code === 'EACCES' && (hasSudoPassword() || params.sudo === '1')) {
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
}

/** Route table — see CLAUDE.md. */
const routes = [
  { name: 'api/download', match: (p, q) => p[1] === 'download' && !!q.path, handle: handleDownload },
  { name: 'api/upload',   match: (p, q) => p[1] === 'upload' && !!q.path,   handle: handleUpload },
];

module.exports = { routes };

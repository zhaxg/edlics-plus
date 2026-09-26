// static.js — static file serving with ETag conditional caching (304) and
// gzip for text assets, plus the URL router (API vs static with containment).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const MIME = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

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
    // The app UI (login form, terminal) must never be framed — not even by a
    // sandboxed preview iframe rendering an untrusted document from disk.
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "frame-ancestors 'none'";
      headers['X-Frame-Options'] = 'DENY';
    }
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

/**
 * Build the HTTP router: /api/* goes to handleApi, everything else to
 * static files with path containment (never escapes PUBLIC_DIR).
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void} handleApi
 */
function makeRouter(handleApi) {
  return function router(req, res) {
    if (req.url.startsWith('/api/')) {
      return handleApi(req, res);
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
  };
}

module.exports = { makeRouter, serveStatic, MIME, PUBLIC_DIR };

// preview-api.js — inline file serving for the in-browser HTML preview.
//
// Why the endpoint: /api/download forces `attachment`, so an iframe pointed at
// it downloads instead of rendering. The target lives in the URL *segments*
// (/api/preview/<abs path>) on purpose — a browser resolves relative URLs
// against the document's own directory, so `style.css` next to the previewed
// page becomes /api/preview/<token>/<dir>/style.css and simply loads.
//
// Why it is dispatched by hand instead of through the ROUTES table: the preview
// iframe is sandboxed without allow-same-origin, so its origin is opaque and
// Chrome treats its subresource requests as cross-site — the SameSite=Strict
// session cookie is never sent, and those requests would 401 on the normal gate.
// So this module authenticates them itself, with a short-lived unguessable token
// carried as a URL *segment* (relative resolution propagates it to every
// sibling request for free). What a token can reach stays boxed in:
//   * every path goes through ctx.checkPath() — root containment + symlink,
//   * anything outside the renderable MIME set comes back as text/plain,
//   * a token minted while --terminal is off can never reach /api/term*.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MIME } = require('./static');

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const PREFIX = '/api/preview/';
const TOKEN_TTL_MS = 10 * 60 * 1000;

// Must render as documents even though static.js's table is incomplete here
// (it has no .htm entry, and text/plain would show source instead of a page).
const DOC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
};

const tokens = new Map(); // token -> { expires, terminal }

function mintToken(terminal) {
  for (const [t, meta] of tokens) if (meta.expires < Date.now()) tokens.delete(t);
  const token = crypto.randomBytes(16).toString('base64url');
  tokens.set(token, { expires: Date.now() + TOKEN_TTL_MS, terminal: !!terminal });
  return token;
}

/** Auth-gated: the SPA asks for one token, then hands it to the iframe. */
function handlePreviewToken(ctx) {
  ctx.ok({ token: mintToken(ctx.terminal), expiresIn: TOKEN_TTL_MS });
}

/**
 * Decide whether a preview request may proceed, and with whose privileges.
 * Exported for unit tests.
 * @param {string|null} token token read from the URL segment, if any
 * @param {boolean} cookieAuthed caller passed the session gate
 * @param {boolean} terminalEnabled server's current --terminal state
 */
function authorizePreview(token, cookieAuthed, terminalEnabled) {
  if (cookieAuthed) return { ok: true, terminal: !!terminalEnabled };
  if (!token) return { ok: false, reason: 'no credentials' };
  const meta = tokens.get(token);
  if (!meta) return { ok: false, reason: 'unknown token' };
  if (meta.expires < Date.now()) {
    tokens.delete(token);
    return { ok: false, reason: 'expired token' };
  }
  return { ok: true, terminal: meta.terminal };
}

/**
 * Content type for an inline preview. Real types are kept for everything
 * static.js knows — a page's own <script src="./app.js"> only runs if it is
 * served as JavaScript — and containment comes from the sandboxed opaque-origin
 * iframe rather than from lying about the type. Anything unmapped (and .md,
 * which the editor renders through marked) becomes text/plain, so a stray
 * binary can never be sniffed as HTML and run.
 * Pure — exported for unit tests.
 * @param {string} filePath
 * @param {string} fallback used for files with no extension
 */
function previewContentType(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!ext) return fallback;
  if (DOC_TYPES[ext]) return DOC_TYPES[ext];
  return MIME[ext] || 'text/plain';
}

/**
 * Split /api/preview/[<token>]<path> into token and target. A leading segment is
 * read as a token only while it is live, so an ordinary file name that happens
 * to look like base64url still resolves as part of the path.
 * Pure about the parsing — exported for unit tests.
 * @param {string} pathname raw, still percent-encoded
 * @param {{has: (t: string) => boolean}} liveTokens
 * @returns {{token: string|null, target: string}}
 */
function parsePreviewUrl(pathname, liveTokens) {
  let rest = decodeURIComponent(String(pathname || '').slice(PREFIX.length));
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  let token = null;
  const first = rest.split('/')[0];
  if (first && liveTokens.has(first)) {
    token = first;
    rest = rest.slice(first.length + 1);
  }
  return { token, target: rest };
}

function streamPreview(ctx, filePath, contentType) {
  const { res, fail } = ctx;
  fs.stat(filePath, (err, stat) => {
    if (err) return fail(err.code === 'ENOENT' ? 'File not found' : err.message, err.code === 'ENOENT' ? 404 : 500);
    if (stat.isDirectory()) return fail('Cannot preview a directory', 400);
    if (stat.size > MAX_PREVIEW_BYTES) return fail('File too large to preview (>20MB)', 413);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      // The frame's origin is opaque, so Chrome's Opaque Response Blocking would
      // otherwise refuse every sibling <link>/<img>/<script>. Safe to opt in: a
      // cross-site request carries neither the cookie nor a live token.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'no-referrer',
      // No X-Frame-Options / frame-ancestors here on purpose: this document IS
      // meant to be framed, by our own preview iframe. What must refuse framing
      // is the app itself (see static.js).
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => { if (!res.writableEnded) res.end(); });
  });
}

function handlePreview(ctx) {
  const { req, fail, checkPath, authed } = ctx;
  if (req.method !== 'GET') return fail('Method not allowed', 405);
  const pathname = req.url.split('?')[0];
  if (!pathname.startsWith(PREFIX)) return fail('Not found', 404);

  const { token, target } = parsePreviewUrl(pathname, tokens);
  const auth = authorizePreview(token, authed, ctx.terminal);
  if (!auth.ok) return fail('Unauthorized: ' + auth.reason, 401);
  if (!target) return fail('Not found', 404);
  // A token minted without --terminal must never escalate into a shell.
  ctx.terminal = auth.terminal;
  if (!checkPath(target)) return;

  streamPreview(ctx, target, previewContentType(target, 'text/plain'));
}

/**
 * Token issuance stays on the auth-gated route table; only the file endpoint is
 * dispatched by hand, because it authenticates itself. See CLAUDE.md.
 */
const routes = [
  { name: 'api/preview-token', match: p => p[1] === 'preview-token', handle: handlePreviewToken },
];

module.exports = {
  routes, handlePreview, previewContentType, parsePreviewUrl, authorizePreview,
  mintToken,
  // Exported so tests can drive the token store directly (backdate an entry to
  // exercise expiry without sleeping for the real TTL).
  tokens,
  TOKEN_TTL_MS,
};

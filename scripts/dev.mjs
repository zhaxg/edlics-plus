#!/usr/bin/env node
/**
 * dev.mjs — dev server with live reload (no dependencies).
 *
 *   npm run dev                          # spawns the app on 127.0.0.1:3100,
 *                                        # serves http://localhost:3000
 *   npm run dev -- --upstream http://127.0.0.1:9688
 *                                        # proxy an instance you already run
 *   npm run dev -- --port 3001 --app-port 3101 --password secret --root /srv
 *   npm run dev -- --hostname 0.0.0.0    # reachable from other machines
 *
 * What it does:
 *   - proxies every request to the app (plain HTTP — the app has no WebSocket),
 *     injecting a live-reload client into HTML responses
 *   - watches public/** and reloads the browser when a file changes; if the
 *     editor has unsaved changes it shows a "click to reload" toast instead,
 *     so a reload never throws away typed-but-unsaved content
 *   - watches bin/** and restarts the spawned app, then reloads the browser
 *     (only in spawn mode; a proxy target is restarted by you)
 *
 * Static files are served from disk on every request (ETag + no-cache), so a
 * plain refresh already shows the latest — this only removes the refresh.
 */

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_DIRS = [path.join(ROOT, 'public'), path.join(ROOT, 'bin')];

function usage() {
  console.log(`dev — live-reload dev server

  --port <n>         dev server port (default 3000)
  --hostname <h>     dev server bind address (default 127.0.0.1)
  --app-port <n>     port for the app this script spawns (default 3100)
  --password <pw>    password for the spawned app (default dev123)
  --root <dir>       --root passed to the spawned app (default ${ROOT})
  --upstream <url>   proxy an already-running app instead of spawning one
  --no-watch         disable file watching / live reload`);
}

function parseArgs(argv) {
  const opts = {
    port: 3000, hostname: '127.0.0.1', appPort: 3100,
    password: 'dev123', root: ROOT, upstream: null, watch: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--hostname') opts.hostname = argv[++i];
    else if (a === '--app-port') opts.appPort = parseInt(argv[++i], 10);
    else if (a === '--password') opts.password = argv[++i];
    else if (a === '--root') opts.root = path.resolve(argv[++i]);
    else if (a === '--upstream') opts.upstream = argv[++i];
    else if (a === '--no-watch') opts.watch = false;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown option: ${a}`); usage(); process.exit(1); }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const up = opts.upstream
  ? new URL(opts.upstream)
  : { protocol: 'http:', hostname: '127.0.0.1', port: opts.appPort };

// ── live-reload client injected into every HTML response ──────────────────
const RELOAD_SNIPPET = `
<script data-dev-livereload>
(() => {
  const log = (m) => console.log('%c[dev] ' + m, 'color:#89b4fa;font-weight:600');
  const es = new EventSource('/__dev/livereload');
  es.onopen = () => log('live-reload connected');
  es.onmessage = (e) => {
    if (e.data !== 'reload') return;
    // Never clobber typed-but-unsaved content: the status bar shows
    // "● modified" while a tab is dirty (pathbar-status.mjs).
    const status = document.getElementById('statusRight');
    if (status && /modified/.test(status.textContent || '')) { toast(); return; }
    log('reloading…');
    location.reload();
  };
  function toast() {
    if (document.getElementById('devReloadToast')) return;
    const el = document.createElement('div');
    el.id = 'devReloadToast';
    el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99999;' +
      'background:#26263a;color:#cdd6f4;border:1px solid #35354d;border-radius:6px;' +
      'padding:9px 13px;font:12px/1.4 system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.5)';
    el.textContent = '⏸ 有未保存的改动 — 点击此处手动刷新';
    el.onclick = () => location.reload();
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }
  es.onerror = () => {}; // EventSource reconnects on its own
})();
</script>`;

function injectReload(html) {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + RELOAD_SNIPPET;
  return html.slice(0, idx) + RELOAD_SNIPPET + html.slice(idx);
}

// ── SSE clients ───────────────────────────────────────────────────────────
const clients = new Set();
const broadcast = (msg) => {
  for (const res of clients) { try { res.write(`data: ${msg}\n\n`); } catch {} }
};

// ── proxy ─────────────────────────────────────────────────────────────────
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade'];

function proxy(req, res) {
  const headers = { ...req.headers, host: `${up.hostname}:${up.port}` };
  for (const h of HOP) delete headers[h];
  headers['accept-encoding'] = 'identity'; // no gzip → easy HTML injection

  const upReq = http.request(
    { host: up.hostname, port: up.port, method: req.method, path: req.url, headers },
    (upRes) => {
      const status = upRes.statusCode;
      const isHtml = String(upRes.headers['content-type'] || '').includes('text/html');
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let body = Buffer.concat(chunks);
        const out = { ...upRes.headers };
        for (const h of [...HOP, 'content-length', 'content-encoding']) delete out[h];
        if (isHtml && body.length && status >= 200 && status < 400) {
          body = Buffer.from(injectReload(body.toString('utf8')));
          delete out.etag; // injected body no longer matches upstream's ETag
        }
        res.writeHead(status, out);
        res.end(body);
      });
    },
  );
  upReq.on('error', (err) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dev proxy: app at ${up.hostname}:${up.port} is not reachable (${err.code || err.message})\n` +
      (opts.upstream ? '' : '\nThe spawned app may still be starting — retry in a second.\n'));
  });
  req.pipe(upReq);
}

const server = http.createServer((req, res) => {
  if (req.url === '/__dev/livereload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  proxy(req, res);
});
// Long-lived SSE + slow uploads
server.keepAliveTimeout = 65_000;
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 25_000).unref();

// ── spawned app (spawn mode only) ─────────────────────────────────────────
let child = null;
let restarting = false;

function startApp() {
  const args = [path.join(ROOT, 'bin', 'edlics.js'), 'serve',
    '--hostname', '127.0.0.1', '--port', String(up.port),
    '--root', opts.root, '--password', opts.password];
  child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (stream) => stream.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line) console.log(`  [app] ${line}`);
  });
  relay(child.stdout); relay(child.stderr);
  child.on('exit', (code, sig) => {
    console.log(`  [app] exited (${sig || code})`);
    child = null;
    if (restarting) restarting = false;
  });
  return child;
}

function waitUpstream(timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: up.hostname, port: up.port, path: '/', timeout: 1500 }, (r) => {
        r.resume(); resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) resolve(false);
        else setTimeout(attempt, 250);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

async function restartApp() {
  if (opts.upstream || restarting || !child) return;
  restarting = true;
  console.log('  [dev] bin/ changed → restarting app…');
  const dying = child;
  dying.once('exit', async () => {
    startApp();
    if (await waitUpstream(20_000)) broadcast('reload');
  });
  dying.kill('SIGTERM');
  setTimeout(() => { try { dying.kill('SIGKILL'); } catch {} }, 5000).unref();
}

// ── watcher: mtime+size poll (portable, no native deps) ───────────────────
function snapshot() {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else { try { const st = statSync(p); map.set(p, `${st.mtimeMs}:${st.size}`); } catch {} }
    }
  };
  for (const d of WATCH_DIRS) walk(d);
  return map;
}

let prev = snapshot();
setInterval(() => {
  let next;
  try { next = snapshot(); } catch { return; }
  const changed = { public: [], bin: [] };
  const bucket = (f) => (f.startsWith(path.join(ROOT, 'bin')) ? changed.bin : changed.public);
  for (const [f, v] of next) if (prev.get(f) !== undefined && prev.get(f) !== v) bucket(f).push(f);
  for (const f of prev.keys()) if (!next.has(f)) bucket(f).push(f);
  prev = next;

  if (changed.public.length) {
    const names = changed.public.map((f) => path.relative(ROOT, f));
    console.log(`  [dev] ${names.length} file(s) changed: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}`);
    broadcast('reload');
  }
  if (changed.bin.length) restartApp();
}, 500).unref();

// ── boot ──────────────────────────────────────────────────────────────────
if (!opts.upstream) startApp();

const ready = await waitUpstream(opts.upstream ? 8000 : 20_000);
server.listen(opts.port, opts.hostname, () => {
  console.log('');
  console.log(`  dev server   http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${opts.port}`);
  console.log(`  app upstream ${up.hostname}:${up.port}${opts.upstream ? ' (external)' : ' (spawned)'}`);
  if (opts.upstream) console.log('  NOTE: restart that instance yourself when bin/ changes');
  console.log(`  watching     ${WATCH_DIRS.map((d) => path.relative(ROOT, d)).join(', ')} → auto reload`);
  console.log('  Ctrl-C to stop\n');
  if (!ready) console.log('  ! app not answering yet — the page will show 502 until it comes up\n');
});

function shutdown() {
  for (const res of clients) { try { res.end(); } catch {} }
  if (child) { try { child.kill('SIGTERM'); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

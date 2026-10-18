#!/usr/bin/env node
// Edlics entry point — CLI parsing, server lifecycle, API dispatch glue.
// Domain logic lives in ./lib/* — see CLAUDE.md for the module map, invariants
// (auth gate, isPathSafe on every path) and the route-table contract.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const staticFiles = require('./lib/static');
const auth = require('./lib/auth');
const paths = require('./lib/paths');
const filesApi = require('./lib/files-api');
const transferApi = require('./lib/transfer-api');
const previewApi = require('./lib/preview-api');
const searchApi = require('./lib/search-api');
const gitApi = require('./lib/git-api');
const terminalApi = require('./lib/terminal-api');
const sysApi = require('./lib/sys-api');
const servicesApi = require('./lib/services-api');
const db = require('./lib/db');
const audit = require('./lib/audit');

// Declarative route table — the full API surface at a glance (see CLAUDE.md).
const ROUTES = [
  ...filesApi.routes,
  ...transferApi.routes,
  ...previewApi.routes,
  ...searchApi.routes,
  ...gitApi.routes,
  ...terminalApi.routes,
  ...sysApi.routes,
  ...servicesApi.routes,
];

let readonly = false; // When true, all write operations are blocked
// Terminal is OFF by default: it grants a full shell, so enabling it must be
// a deliberate act (--terminal). --readonly always wins and disables it.
let terminalEnabled = false; (--readonly)
// Admin panel (system metrics/services/…) is OFF by default and root-grade;
// every /api/sys/* endpoint is gated behind --admin.
let adminEnabled = false;
let adminWriteEnabled = false;

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
  // Helper: fail if the resolved path is outside the root directory
  function checkPath(p) {
    if (!paths.isPathSafe(p)) { fail('Access denied: path outside root directory', 403); return false; }
    return true;
  }

  /** Shared request context handed to every route handler. */
  const ctx = {
    req, res, parts, params, ok, fail, checkReadonly, checkPath,
    readonly, rootDir: paths.getRootDir(), terminal: terminalEnabled,
    admin: adminEnabled, adminWrite: adminWriteEnabled,
    authed: auth.isAuthed(req),
  };

  try {
    // Public auth routes (session/login/logout) handle themselves
    if (auth.handleAuthRoutes(parts, req, res, ok, fail)) return;

    // --- HTML preview files authenticate themselves (token in the URL segment,
    // because a sandboxed iframe never sends the SameSite=Strict cookie), so they
    // run ahead of the session gate. Token *issuance* stays behind it.
    if (parts[0] === 'api' && parts[1] === 'preview') return previewApi.handlePreview(ctx);

    // --- Everything below requires an authenticated session ---
    if (!ctx.authed) return fail('Unauthorized', 401);

    const route = ROUTES.find(r => r.match(parts, params));
    if (!route) return fail('Not found', 404);
    // The terminal is a full shell — gated behind an explicit opt-in flag.
    if (route.name.startsWith('api/term') && !terminalEnabled) {
      return fail('Terminal is disabled. Start the server with --terminal to enable it (not compatible with --readonly).', 403);
    }
    // The admin panel is root-grade — gated behind --admin.
    if (route.name.startsWith('api/sys') && !adminEnabled) {
      return fail('Admin panel is disabled. Start the server with --admin to enable it.', 403);
    }
    route.handle(ctx);
  } catch (e) {
    fail(e.message);
  }
}

const router = staticFiles.makeRouter(handleAPI);

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = { hostname: '127.0.0.1', port: 3000, root: null, readonly: false, password: null, terminal: false,
    admin: false, adminWrite: false, dataDir: null, retentionDays: 30, cookieSecure: false };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hostname' && args[i + 1]) opts.hostname = args[++i];
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === '--root' && args[i + 1]) opts.root = args[++i];
    if (args[i] === '--password' && args[i + 1]) opts.password = args[++i];
    if (args[i] === '--readonly') opts.readonly = true;
    if (args[i] === '--terminal') opts.terminal = true;
    if (args[i] === '--admin') opts.admin = true;
    if (args[i] === '--admin-write') { opts.admin = true; opts.adminWrite = true; }
    if (args[i] === '--data-dir' && args[i + 1]) opts.dataDir = args[++i];
    if (args[i] === '--retention-days' && args[i + 1]) opts.retentionDays = parseInt(args[++i]);
    if (args[i] === '--cookie-secure') opts.cookieSecure = true;
  }
  return { cmd, opts };
}

/** Where the metrics/audit SQLite file lives (override with --data-dir). */
function resolveDataDir(opts) {
  return opts.dataDir || process.env.EDLICS_DATA_DIR || path.join(require('os').homedir(), '.edlics');
}

/**
 * Wire up persistence-backed auth (lockouts survive restarts) and the audit
 * trail. Only meaningful when --admin opened the DB.
 */
function wireAdminPersistence() {
  auth.setAttemptStore({
    get(ip) {
      const row = db.getDb().prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').get(ip);
      return row ? { fails: row.fails, lockedUntil: row.locked_until } : undefined;
    },
    set(ip, a) {
      db.getDb().prepare(
        'INSERT INTO login_attempts (ip, fails, locked_until, updated) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, updated = excluded.updated'
      ).run(ip, a.fails | 0, a.lockedUntil | 0, Date.now());
    },
    del(ip) { try { db.getDb().prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip); } catch {} },
  });
  const meta = (req) => ({
    ip: req.socket.remoteAddress || 'unknown',
    ua: req.headers['user-agent'] || '',
  });
  auth.setHooks({
    onLogin: (ip, req) => audit.log('login', { ...meta(req), result: 'ok' }),
    onLoginFail: (ip, req) => audit.log('login.fail', { ...meta(req), result: 'wrong-password' }),
    onLocked: (scope, ip, req) => audit.log('login.locked', { ...meta(req), result: scope }),
  });
  sysApi.init({ retentionDays: optsRetentionDays });
  audit.prune(90);
}

// retentionDays is read here (set from CLI in startServer before wiring).
let optsRetentionDays = 30;

function startServer(opts) {
  readonly = opts.readonly;
  terminalEnabled = !!opts.terminal && !opts.readonly;
  adminEnabled = !!opts.admin;
  adminWriteEnabled = !!opts.adminWrite;
  optsRetentionDays = opts.retentionDays || 30;
  auth.setCookieSecure(opts.cookieSecure);

  // Password: --password flag > EDLICS_PASSWORD env > auto-generated (printed once)
  let password = opts.password || process.env.EDLICS_PASSWORD;
  let generatedPassword = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generatedPassword = true;
  }
  auth.setPassword(password);

  // Persistence + audit (only when the admin panel is on).
  if (adminEnabled) {
    const dataDir = resolveDataDir(opts);
    db.open(path.join(dataDir, 'edlics.db'));
    wireAdminPersistence();
  }

  if (opts.root) {
    const rootDir = path.resolve(opts.root);
    if (!fs.existsSync(rootDir)) {
      console.error(`\n  Error: root directory does not exist: ${rootDir}\n`);
      process.exit(1);
    }
    if (!fs.statSync(rootDir).isDirectory()) {
      console.error(`\n  Error: root path is not a directory: ${rootDir}\n`);
      process.exit(1);
    }
    paths.setRootDir(rootDir);
  }

  const server = http.createServer(router);
  server.listen(opts.port, opts.hostname, () => {
    console.log(`\n  Edlics running at:`);
    console.log(`  Local:   http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${opts.port}`);
    if (generatedPassword) {
      console.log(`  Password: ${password}  (auto-generated — set --password or EDLICS_PASSWORD to choose your own)`);
    }
    const rootDir = paths.getRootDir();
    if (rootDir) {
      console.log(`  Root:    ${paths.toPosix(rootDir)}`);
    }
    if (adminEnabled) {
      console.log(`  Admin:   enabled${adminWriteEnabled ? ' (write)' : ' (read-only)'} — DB at ${paths.toPosix(path.join(resolveDataDir(opts), 'edlics.db'))}`);
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

  // --- graceful shutdown + crash containment (long-running robustness) ---
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { sysApi.shutdown(); } catch {}
    try { db.close(); } catch {}
    try { server.close(); } catch {}
    const t = setTimeout(() => process.exit(0), 2000);
    t.unref?.();
    server.on('close', () => process.exit(0));
    if (signal) console.log(`\n  Received ${signal}, shutting down…`);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', err => {
    console.error('\n  Uncaught exception — exiting for a clean restart:\n', err);
    shutdown();
  });
  process.on('unhandledRejection', reason => {
    console.error('\n  Unhandled rejection:\n', reason);
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
    --terminal   Enable the built-in terminal — OFF by default, grants a full
                 shell (read README「安全说明」before using; not with --readonly)
    --admin      Enable the web admin panel (metrics/history/system info) —
                 OFF by default, root-grade; read docs/ADMIN-PANEL-PLAN.md
    --admin-write  Also allow admin write actions (implies --admin)
    --data-dir   Where the metrics/audit SQLite file lives (default ~/.edlics)
    --retention-days  Metric history retention in days (default 30)
    --cookie-secure   Add Secure to the session cookie (enable when behind TLS)

  Examples:
    edlics serve
    edlics serve --hostname 0.0.0.0 --port 5000 --password secret
    edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www --terminal
    edlics serve --admin --port 8088 --password secret
  `);
}

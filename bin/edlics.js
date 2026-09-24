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
const searchApi = require('./lib/search-api');
const gitApi = require('./lib/git-api');
const terminalApi = require('./lib/terminal-api');

// Declarative route table — the full API surface at a glance (see CLAUDE.md).
const ROUTES = [
  ...filesApi.routes,
  ...transferApi.routes,
  ...searchApi.routes,
  ...gitApi.routes,
  ...terminalApi.routes,
];

let readonly = false; // When true, all write operations are blocked
// Terminal is OFF by default: it grants a full shell, so enabling it must be
// a deliberate act (--terminal). --readonly always wins and disables it.
let terminalEnabled = false; (--readonly)

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
  };

  try {
    // Public auth routes (session/login/logout) handle themselves
    if (auth.handleAuthRoutes(parts, req, res, ok, fail)) return;

    // --- Everything below requires an authenticated session ---
    if (!auth.isAuthed(req)) return fail('Unauthorized', 401);

    const route = ROUTES.find(r => r.match(parts, params));
    if (!route) return fail('Not found', 404);
    // The terminal is a full shell — gated behind an explicit opt-in flag.
    if (route.name.startsWith('api/term') && !terminalEnabled) {
      return fail('Terminal is disabled. Start the server with --terminal to enable it (not compatible with --readonly).', 403);
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
  const opts = { hostname: '127.0.0.1', port: 3000, root: null, readonly: false, password: null, terminal: false };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hostname' && args[i + 1]) opts.hostname = args[++i];
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i]);
    if (args[i] === '--root' && args[i + 1]) opts.root = args[++i];
    if (args[i] === '--password' && args[i + 1]) opts.password = args[++i];
    if (args[i] === '--readonly') opts.readonly = true;
    if (args[i] === '--terminal') opts.terminal = true;
  }
  return { cmd, opts };
}

function startServer(opts) {
  readonly = opts.readonly;
  terminalEnabled = !!opts.terminal && !opts.readonly;

  // Password: --password flag > EDLICS_PASSWORD env > auto-generated (printed once)
  let password = opts.password || process.env.EDLICS_PASSWORD;
  let generatedPassword = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generatedPassword = true;
  }
  auth.setPassword(password);

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
    --terminal   Enable the built-in terminal — OFF by default, grants a full
                 shell (read README「安全说明」before using; not with --readonly)

  Examples:
    edlics serve
    edlics serve --hostname 0.0.0.0 --port 5000 --password secret
    edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www --terminal
  `);
}

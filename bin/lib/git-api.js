// git-api.js — read-only Git endpoints. All commands run via execFile with
// cwd = workspace (no shell), sha values whitelisted, pathspecs after '--'.
const fs = require('fs');
const { execFile } = require('child_process');
const { isPathSafe } = require('./paths');

/**
 * @typedef {Object} GitStatusEntry
 * @property {string} xy   porcelain status code (e.g. ' M', '??', 'A ')
 * @property {string} path repo-relative path
 * @typedef {Object} GitLogEntry
 * @property {string} hash
 * @property {string} short
 * @property {string} author
 * @property {string} date
 * @property {string} subject
 * @typedef {Object} GitCommitFile
 * @property {string} status single letter (A/M/D/…)
 * @property {string} path
 */

function gitWorkspace(ctx) {
  const ws = ctx.params.path;
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

/**
 * Parse `git status --porcelain=v1 -z -b` output.
 * First NUL field is the "## branch" header; remaining fields are entries
 * (renames emit the new path in the entry and the old path as the next field).
 * @param {string} out
 * @returns {{branch: string, changes: GitStatusEntry[]}}
 */
function parseStatusZ(out) {
  const chunks = out.split('\0');
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
  return { branch, changes };
}

/**
 * Parse `git log --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s` output.
 * @param {string} out
 * @returns {GitLogEntry[]}
 */
function parseLog(out) {
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, short, author, date, ...subject] = line.split('\x1f');
    return { hash, short, author, date, subject: subject.join('\x1f') };
  });
}

/**
 * Parse `git diff-tree --name-status -z` output (alternating status/path fields).
 * @param {string} out
 * @returns {GitCommitFile[]}
 */
function parseCommitFilesZ(out) {
  const chunks = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const status = chunks[i];
    if (!/^[AMDRTC]\d?$/.test(status)) continue;
    const file = chunks[++i];
    if (file) files.push({ status: status[0], path: file });
  }
  return files;
}

function handleStatus(ctx) {
  const { params, ok, fail } = ctx;
  const ws = gitWorkspace(ctx);
  if (!ws) return fail('Invalid workspace', 400);
  gitRun(ws, ['status', '--porcelain=v1', '-z', '-b'], (e, r) => {
    if (!r.ok) return ok({ repo: false, error: r.error });
    const { branch, changes } = parseStatusZ(r.out);
    ok({ repo: true, branch, changes });
  });
}

function handleLog(ctx) {
  const { params, ok, fail } = ctx;
  const ws = gitWorkspace(ctx);
  if (!ws) return fail('Invalid workspace', 400);
  const n = Math.min(parseInt(params.n) || 50, 200);
  gitRun(ws, ['log', '-n', String(n), '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'], (e, r) => {
    if (!r.ok) return ok({ repo: false, error: r.error, commits: [] });
    ok({ repo: true, commits: parseLog(r.out) });
  });
}

function handleCommitFiles(ctx) {
  const { params, ok, fail } = ctx;
  const ws = gitWorkspace(ctx);
  if (!ws) return fail('Invalid workspace', 400);
  const sha = params.sha || '';
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return fail('Invalid commit sha', 400);
  gitRun(ws, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', sha], (e, r) => {
    if (!r.ok) return ok({ repo: false, error: r.error, files: [] });
    ok({ repo: true, files: parseCommitFilesZ(r.out) });
  });
}

function handleDiff(ctx) {
  const { params, ok, fail } = ctx;
  const ws = gitWorkspace(ctx);
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
}

function handleShow(ctx) {
  const { params, ok, fail } = ctx;
  const ws = gitWorkspace(ctx);
  if (!ws) return fail('Invalid workspace', 400);
  const sha = params.sha || '';
  const file = params.file;
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return fail('Invalid commit sha', 400);
  if (!file) return fail('file required', 400);
  gitRun(ws, ['show', '--no-color', '--format=', sha, '--', file], (e, r) => {
    if (!r.ok) return fail(r.error, 500);
    ok({ diff: r.out });
  });
}

/** Route table — see CLAUDE.md. */
const routes = [
  { name: 'api/git/status',        match: p => p[1] === 'git' && p[2] === 'status',        handle: handleStatus },
  { name: 'api/git/log',           match: p => p[1] === 'git' && p[2] === 'log',           handle: handleLog },
  { name: 'api/git/commit-files',  match: p => p[1] === 'git' && p[2] === 'commit-files',  handle: handleCommitFiles },
  { name: 'api/git/diff',          match: p => p[1] === 'git' && p[2] === 'diff',          handle: handleDiff },
  { name: 'api/git/show',          match: p => p[1] === 'git' && p[2] === 'show',          handle: handleShow },
];

module.exports = { routes, parseStatusZ, parseLog, parseCommitFilesZ };

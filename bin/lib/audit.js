// audit.js — privileged-action audit trail (who / when / from where / what).
//
// Every write action and every login attempt lands here, independent of any
// in-memory state, so a restart never erases the record. Queryable at
// /api/sys/audit. See docs/ADMIN-PANEL-PLAN.md (Phase 0.5).
const { getDb } = require('./db');

const MAX_LIMIT = 500;

/**
 * Append one audit row. Never throws — auditing must not break the action.
 * @param {string} action  e.g. 'login', 'login.fail', 'service.restart'
 * @param {{ip?:string, ua?:string, target?:string, result?:string}} [meta]
 */
function log(action, meta = {}) {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      'INSERT INTO audit_log (ts, ip, ua, action, target, result) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(Date.now(), meta.ip || null, (meta.ua || '').slice(0, 256) || null,
      String(action).slice(0, 64), meta.target != null ? String(meta.target).slice(0, 512) : null,
      meta.result || null);
  } catch { /* auditing is best-effort */ }
}

/**
 * @param {{limit?:number, offset?:number, action?:string}} [opts]
 * @returns {{rows: object[], total: number}}
 */
function query(opts = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(opts.limit, 10) || 100));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  try {
    let rows, total;
    if (opts.action) {
      total = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(opts.action).n;
      rows = db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(opts.action, limit, offset);
    } else {
      total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
      rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    }
    return { rows, total };
  } catch {
    return { rows: [], total: 0 };
  }
}

/** Retention: drop rows older than `days` (default 90). */
function prune(days = 90) {
  const db = getDb();
  if (!db) return;
  try { db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - days * 86400 * 1000); } catch {}
}

module.exports = { log, query, prune };

// db.js — SQLite persistence via node:sqlite (zero native deps, Node 22+).
//
// This module ONLY owns the connection and the schema/migrations. Domain
// modules (metrics / audit / auth) run their own SQL through getDb(), keeping
// the "one place that knows the shape of the database" honest.
//
// Long-running invariant (CLAUDE.md): the DB is opened once at startup when
// --admin is on; every writer must be bounded (retention sweep below).
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

let db = null;
let dbFile = null;

/**
 * Open (and migrate) the database. Idempotent.
 * @param {string} file absolute path to the .db file
 */
function open(file) {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite'); // lazy: no experimental warning unless --admin
  dbFile = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate();
  return db;
}

/** Create tables/indexes if missing. Safe to run on every boot. */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_min (
      ts         INTEGER PRIMARY KEY,   -- epoch SECONDS at the start of the minute
      cpu        REAL,                  -- 0..100
      mem_used   INTEGER,               -- bytes
      mem_total  INTEGER,
      swap_used  INTEGER,
      swap_total INTEGER,
      load1      REAL,
      load5      REAL,
      load15     REAL,
      uptime     INTEGER,               -- seconds
      net_rx     INTEGER,               -- bytes accumulated this minute
      net_tx     INTEGER,
      disk_read  INTEGER,
      disk_write INTEGER,
      samples    INTEGER                -- how many 1s samples fed this bucket
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      ip     TEXT,
      ua     TEXT,
      action TEXT NOT NULL,
      target TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip           TEXT PRIMARY KEY,
      fails        INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated      INTEGER
    );

    -- Login sessions survive restarts. Only a SHA-256 of the cookie token is
    -- stored, so a leaked database cannot be replayed as a session.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created    INTEGER NOT NULL,   -- epoch ms: absolute cap (never slides)
      seen       INTEGER NOT NULL,   -- epoch ms: last use (slides the idle TTL)
      expires    INTEGER NOT NULL,   -- epoch ms: idle deadline
      ip         TEXT,
      ua         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function getDb() { return db; }
function isOpen() { return !!db; }

/** Close cleanly (graceful shutdown). */
function close() {
  if (db) { try { db.close(); } catch { /* already gone */ } db = null; }
}

module.exports = { open, getDb, isOpen, close, SCHEMA_VERSION };

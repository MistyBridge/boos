// SQLite identity store — Sprint 42: replaces PostgreSQL.
//
// PostgreSQL was docker-dependent and NEVER actually ran (daemon absent,
// every call degraded to JSON fallback). SQLite (built-in node:sqlite)
// gives the same authoritative identity index with zero deployment.
//
// API-compatible with the old postgres.getPool() so identityAdapter only
// changes its require path. PG $1/$2 placeholders are converted to SQLite
// ? positionally.
//
// Requires node --experimental-sqlite (Node 22.5+). bin/boos.js injects
// NODE_OPTIONS=--experimental-sqlite when spawning the server.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DB_PATH = process.env.BOOS_SQLITE_DB || path.join(os.homedir(), '.boos', 'agent-bus.db');

let _db = null;

function _runDDL(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_index (
      cli_session_id TEXT PRIMARY KEY,
      agent_name     TEXT,
      workspace      TEXT,
      role           TEXT,
      capabilities   TEXT,
      mcp_session_id TEXT,
      pty_pid        INTEGER,
      cwd            TEXT,
      updated_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      cli_session_id  TEXT PRIMARY KEY,
      boos_session_id TEXT UNIQUE,
      cwd             TEXT,
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_identity_mcp     ON identity_index(mcp_session_id);
    CREATE INDEX IF NOT EXISTS idx_identity_name_ws ON identity_index(agent_name, workspace);
  `);
}

function getDb() {
  if (_db) return _db;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new (require('node:sqlite').DatabaseSync)(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA busy_timeout = 5000');
    _runDDL(_db);
  } catch (e) {
    // node:sqlite unavailable (no --experimental-sqlite) — return null so
    // callers degrade to their JSON fallback path.
    console.warn('[sqliteStore] unavailable:', e.message);
    return null;
  }
  return _db;
}

// PG $1/$2 placeholders → SQLite ? with a rebuilt bind list.
// A repeated $n must bind the SAME parameter at every occurrence —
// naive sequential replacement misaligns (e.g. $1 used twice).
function _convertAndBind(sql, params) {
  const binds = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n) => {
    const idx = parseInt(n, 10) - 1;
    let v = params[idx];
    // SQLite cannot bind JS arrays (PG text[] can) — serialize to JSON.
    if (Array.isArray(v)) v = JSON.stringify(v);
    binds.push(v);
    return '?';
  });
  return { sql: out, binds };
}

const pool = {
  query(sql, params = []) {
    const db = getDb();
    if (!db) throw new Error('sqlite store unavailable');
    const { sql: out, binds } = _convertAndBind(sql, params);
    const stmt = db.prepare(out);
    const rows = stmt.all(...binds);
    return { rows };
  },
  close() {
    if (_db) { try { _db.close(); } catch {} _db = null; }
  },
};

// Drop the database file (for tests / recalibration).
function dropDatabase() {
  pool.close();
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
}

function getPool() {
  return getDb() ? pool : null;
}

module.exports = { getPool, getDb, dropDatabase, DB_PATH };

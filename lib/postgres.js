// PostgreSQL Docker lifecycle + connection pool — Sprint 7.
//
// Manages a Docker postgres:16-alpine container (named "boos-db"). On boot,
// ensures the container is running and healthy, creates the conversation
// tables, and exposes a pg Pool for the rest of the app.
//
// Degradation: if Docker is not installed or fails to start, `available` is
// false, `getPool()` returns null, and every `query()` is a quiet no-op.
// The server boots normally — just without conversation persistence.
//
// exports:
//   ensureContainer()  async — start container, wait healthy, run DDL
//   stopContainer()    async — docker stop + pool.end()
//   query(text, params?)  async → pg.Result | null
//   getPool()             → Pool | null
//   isAvailable()         → boolean

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const CONTAINER = 'boos-db';
const IMAGE = 'postgres:16-alpine';
const PORT = 5432;
const PASSWORD = 'boos-local-dev';
const DATABASE = 'boos';
const USER = 'postgres';

let _pool = null;       // pg.Pool | null
let _available = false;
let _ensured = false;

// ── Docker helpers ────────────────────────────────────────────────────────

function _docker(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    };
    try {
      child = spawn('docker', args, { windowsHide: true });
    } catch {
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(-1);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

async function _dockerOk() {
  const r = await _docker(['ps'], 10_000);
  return r.code === 0;
}

async function _imageExists() {
  const r = await _docker(['images', '-q', IMAGE], 15_000);
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function _pullImage() {
  console.log('[boos] postgres: pulling', IMAGE, '…');
  const r = await _docker(['pull', IMAGE], 120_000);
  if (r.code !== 0) {
    console.warn('[boos] postgres: docker pull failed —', r.stderr.slice(0, 200));
    return false;
  }
  return true;
}

async function _containerExists() {
  const r = await _docker(['ps', '-a', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}}'], 10_000);
  return r.stdout.trim() === CONTAINER;
}

async function _containerRunning() {
  const r = await _docker(['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}}'], 10_000);
  return r.stdout.trim() === CONTAINER;
}

async function _startContainer() {
  console.log('[boos] postgres: starting container', CONTAINER, '…');
  const r = await _docker([
    'run', '-d',
    '--name', CONTAINER,
    '-p', `${PORT}:5432`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', `POSTGRES_DB=${DATABASE}`,
    IMAGE,
  ], 30_000);
  if (r.code !== 0) {
    // If the container already exists but is stopped, try starting it.
    if (r.stderr.includes('Conflict') || r.stderr.includes('is already in use')) {
      const startResult = await _docker(['start', CONTAINER], 15_000);
      if (startResult.code !== 0) {
        console.warn('[boos] postgres: docker start failed —', startResult.stderr.slice(0, 200));
        return false;
      }
      return true;
    }
    console.warn('[boos] postgres: docker run failed —', r.stderr.slice(0, 200));
    return false;
  }
  return true;
}

async function _waitHealthy(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await _docker(['exec', CONTAINER, 'pg_isready', '-U', USER], 10_000);
    if (r.code === 0) return true;
    await _sleep(500);
  }
  console.warn('[boos] postgres: container did not become healthy within', timeoutMs, 'ms');
  return false;
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pool + DDL ────────────────────────────────────────────────────────────

async function _initPool() {
  let pg;
  try {
    pg = require('pg');
  } catch {
    console.warn('[boos] postgres: pg module not available');
    return null;
  }
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
  });
  // Verify connectivity.
  try {
    const client = await pool.connect();
    client.release();
  } catch (e) {
    console.warn('[boos] postgres: pool connection test failed —', e.message);
    await pool.end().catch(() => {});
    return null;
  }
  return pool;
}

async function _runDDL(pool) {
  const ddl = `
    CREATE TABLE IF NOT EXISTS conversation_files (
      cli_session_id  TEXT PRIMARY KEY,
      boos_session_id TEXT NOT NULL,
      project_slug    TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      jsonl_path      TEXT NOT NULL,
      last_offset     BIGINT DEFAULT 0,
      last_mtime_ms   BIGINT DEFAULT 0,
      turn_count      INTEGER DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id              SERIAL PRIMARY KEY,
      cli_session_id  TEXT NOT NULL REFERENCES conversation_files ON DELETE CASCADE,
      turn_index      INTEGER NOT NULL,
      turn_type       TEXT NOT NULL,
      content_text    TEXT,
      raw_json        JSONB NOT NULL,
      synced_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(cli_session_id, turn_index)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_turns_session
      ON conversation_turns (cli_session_id, turn_index);

    CREATE INDEX IF NOT EXISTS idx_conversation_files_cwd
      ON conversation_files (cwd, updated_at DESC);
  `;
  try {
    await pool.query(ddl);
    console.log('[boos] postgres: DDL applied (conversation_files + conversation_turns)');
    return true;
  } catch (e) {
    console.warn('[boos] postgres: DDL failed —', e.message);
    return false;
  }
}

// ── public API ────────────────────────────────────────────────────────────

async function ensureContainer() {
  if (_ensured) return _available;
  _ensured = true;

  if (process.env.BOOS_NO_POSTGRES === '1') {
    console.log('[boos] postgres: disabled (BOOS_NO_POSTGRES=1)');
    return false;
  }

  // 1. Verify Docker is reachable.
  const ok = await _dockerOk();
  if (!ok) {
    console.warn('[boos] postgres: docker not available — conversation persistence disabled');
    _available = false;
    return false;
  }

  // 2. Ensure image exists.
  if (!(await _imageExists())) {
    if (!(await _pullImage())) {
      _available = false;
      return false;
    }
  }

  // 3. Ensure container is running.
  if (!(await _containerRunning())) {
    if (!(await _startContainer())) {
      _available = false;
      return false;
    }
  }

  // 4. Wait for PG to be ready.
  if (!(await _waitHealthy())) {
    _available = false;
    return false;
  }

  // 5. Create pool + run DDL.
  _pool = await _initPool();
  if (!_pool) {
    _available = false;
    return false;
  }
  if (!(await _runDDL(_pool))) {
    await _pool.end().catch(() => {});
    _pool = null;
    _available = false;
    return false;
  }

  _available = true;
  console.log('[boos] postgres: ready — pool connected, tables created');
  return true;
}

async function stopContainer() {
  if (_pool) {
    try { await _pool.end(); } catch {}
    _pool = null;
  }
  if (_available) {
    console.log('[boos] postgres: stopping container', CONTAINER, '…');
    await _docker(['stop', '-t', '10', CONTAINER], 15_000).catch(() => {});
  }
  _available = false;
  _ensured = false;
}

async function query(text, params) {
  if (!_pool) return null;
  try {
    return await _pool.query(text, params);
  } catch (e) {
    console.warn('[boos] postgres: query failed —', e.message);
    return null;
  }
}

function getPool() {
  return _pool;
}

function isAvailable() {
  return _available;
}

module.exports = {
  ensureContainer,
  stopContainer,
  query,
  getPool,
  isAvailable,
};

// Sprint 33: Identity Adapter — universal UUID-based router over PostgreSQL.
//
// SINGLE SOURCE OF TRUTH: identity_index + agent_sessions tables in boos-db.
// Every function inputs a UUID (cliSessionId) and the adapter routes to ALL
// associated parameters: name, workspace, role, sessions, MCP transport, PTY.
//
// ALL indexes are strictly 1:1:
//   identity_index:  1 cliSessionId : 1 identity row (PK)
//                    1 mcpSessionId  : 1 agent        (UNIQUE)
//                    1 name+ws       : 1 agent        (UNIQUE)
//   agent_sessions:  1 cliSessionId  : 1 boosSession  (PK)
//                    1 boosSessionId : 1 agent        (UNIQUE)
//
// Degradation: when PostgreSQL is unavailable, falls back to agent-bus.json
// (storeCore). This ensures the server boots and operates without Docker.
//
// API:
//   resolve(uuid)            → identity row + session
//   resolveByName(name, ws)  → identity row
//   resolveBySession(sessId) → identity row
//   resolveByMcp(mcpId)      → identity row
//   upsert(uuid, fields)     → write identity
//   linkSession(uuid, sessId, cwd) → 1:1 session binding (UPSERT)
//   unlinkSession(sessId)    → DELETE session row
//   syncFromJson()           → boot-time migration agent-bus.json → PG

'use strict';

// Sprint 42: PostgreSQL → SQLite (docker-independent, actually runs).
const postgres = require('./sqliteStore');

// ── Schema (DDL fragment injected into postgres.js _runDDL) ──────────────

const IDENTITY_DDL = `
  CREATE TABLE IF NOT EXISTS identity_index (
    cli_session_id  TEXT PRIMARY KEY,
    agent_name      TEXT NOT NULL,
    workspace       TEXT NOT NULL DEFAULT 'boos',
    role            TEXT NOT NULL DEFAULT 'worker',
    capabilities    TEXT[] DEFAULT '{}',
    mcp_session_id  TEXT UNIQUE,
    pty_pid         INTEGER DEFAULT 0,
    cwd             TEXT,
    registered_at   TIMESTAMPTZ DEFAULT datetime("now"),
    updated_at      TIMESTAMPTZ DEFAULT datetime("now"),
    UNIQUE (agent_name, workspace)
  );

  CREATE TABLE IF NOT EXISTS agent_sessions (
    cli_session_id  TEXT PRIMARY KEY REFERENCES identity_index ON DELETE CASCADE,
    boos_session_id TEXT NOT NULL UNIQUE,
    cwd             TEXT,
    updated_at      TIMESTAMPTZ DEFAULT datetime("now")
  );
`;

// ── Row builder ─────────────────────────────────────────────────────────

function _rowToIdentity(row) {
  if (!row) return null;
  return {
    uid: row.cli_session_id,
    name: row.agent_name,
    workspace: row.workspace || 'boos',
    role: row.role || 'worker',
    capabilities: (() => {
      const c = row.capabilities;
      if (!c) return [];
      if (Array.isArray(c)) return c;
      try { const parsed = JSON.parse(c); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    })(),
    mcp_session_id: row.mcp_session_id || null,
    pty_pid: row.pty_pid || 0,
    cwd: row.cwd || null,
    sessions: row.boos_session_id ? [row.boos_session_id] : [],
    registered_at: row.registered_at,
    updated_at: row.updated_at,
    // Compat: legacy callers that read these fields.
    boos_session_id: row.boos_session_id || null,
    agent_uid: row.cli_session_id,
    cli_session_id: row.cli_session_id,
  };
}

// ── Resolve: UUID → everything ──────────────────────────────────────────
// All queries are 1:1 — no array_agg, no is_current filter, no GROUP BY.

async function resolve(uuid) {
  if (!uuid || typeof uuid !== 'string') return null;

  const pool = postgres.getPool();
  if (!pool) return _resolveFromJson(uuid);

  try {
    const r = await pool.query(
      `SELECT i.*, s.boos_session_id
       FROM identity_index i
       LEFT JOIN agent_sessions s ON i.cli_session_id = s.cli_session_id
       WHERE i.cli_session_id = $1`,
      [uuid]
    );
    return _rowToIdentity(r.rows[0] || null);
  } catch (e) {
    console.warn('[identityAdapter] resolve failed:', e.message);
    return _resolveFromJson(uuid);
  }
}

async function resolveByName(name, workspace) {
  if (!name) return null;

  const pool = postgres.getPool();
  if (!pool) return _resolveFromJson(null, name, workspace);

  try {
    const r = await pool.query(
      `SELECT i.*, s.boos_session_id
       FROM identity_index i
       LEFT JOIN agent_sessions s ON i.cli_session_id = s.cli_session_id
       WHERE i.agent_name = $1 AND i.workspace = $2`,
      [name, workspace || 'boos']
    );
    return _rowToIdentity(r.rows[0] || null);
  } catch (e) {
    console.warn('[identityAdapter] resolveByName failed:', e.message);
    return _resolveFromJson(null, name, workspace);
  }
}

async function resolveBySession(sessionId) {
  if (!sessionId) return null;

  const pool = postgres.getPool();
  if (!pool) return _resolveFromJsonBySession(sessionId);

  try {
    const r = await pool.query(
      `SELECT i.*, s.boos_session_id
       FROM agent_sessions s
       JOIN identity_index i ON i.cli_session_id = s.cli_session_id
       WHERE s.boos_session_id = $1`,
      [sessionId]
    );
    return _rowToIdentity(r.rows[0] || null);
  } catch (e) {
    console.warn('[identityAdapter] resolveBySession failed:', e.message);
    return _resolveFromJsonBySession(sessionId);
  }
}

async function resolveByMcp(mcpSessionId) {
  if (!mcpSessionId) return null;

  const pool = postgres.getPool();
  if (!pool) return _resolveFromJsonByMcp(mcpSessionId);

  try {
    const r = await pool.query(
      `SELECT i.*, s.boos_session_id
       FROM identity_index i
       LEFT JOIN agent_sessions s ON i.cli_session_id = s.cli_session_id
       WHERE i.mcp_session_id = $1`,
      [mcpSessionId]
    );
    return _rowToIdentity(r.rows[0] || null);
  } catch (e) {
    console.warn('[identityAdapter] resolveByMcp failed:', e.message);
    return _resolveFromJsonByMcp(mcpSessionId);
  }
}

// ── Write operations ────────────────────────────────────────────────────

async function upsert(uuid, fields) {
  if (!uuid) return null;

  const pool = postgres.getPool();
  if (!pool) return null; // JSON fallback handled by storeIdentity

  try {
    // Guard: ensure the row exists before the full upsert.
    // agent_name is NOT NULL — when callers like transport.js pass only
    // { mcp_session_id } before register_agent runs, we use the UUID
    // as a temporary fallback name. The real name is set later by
    // register_agent → _register → adapter.upsert({ name, ... }).
    await pool.query(
      `INSERT INTO identity_index (cli_session_id, agent_name, workspace, role)
       VALUES ($1, $2, $3, 'worker')
       ON CONFLICT (cli_session_id) DO NOTHING`,
      [uuid, fields.name || uuid.slice(0, 64), fields.workspace || 'boos']
    );

    await pool.query(
      `INSERT INTO identity_index (cli_session_id, agent_name, workspace, role, capabilities, mcp_session_id, pty_pid, cwd, updated_at)
       VALUES ($1, COALESCE($2, $1), COALESCE($3, 'boos'), COALESCE($4, 'worker'), $5, $6, $7, $8, datetime("now"))
       ON CONFLICT (cli_session_id) DO UPDATE SET
         agent_name = COALESCE($2, identity_index.agent_name),
         workspace = COALESCE($3, identity_index.workspace),
         role = COALESCE($4, identity_index.role),
         capabilities = COALESCE($5, identity_index.capabilities),
         mcp_session_id = COALESCE($6, identity_index.mcp_session_id),
         pty_pid = COALESCE($7, identity_index.pty_pid),
         cwd = COALESCE($8, identity_index.cwd),
         updated_at = datetime("now")`,
      [
        uuid,
        fields.name || null,
        fields.workspace || null,
        fields.role || null,
        fields.capabilities || null,
        fields.mcp_session_id || null,
        typeof fields.pty_pid === 'number' ? fields.pty_pid : null,
        fields.cwd || null,
      ]
    );
    return await resolve(uuid);
  } catch (e) {
    console.warn('[identityAdapter] upsert failed:', e.message);
    return _writeToJson(uuid, fields);
  }
}

// Sprint 33: 1:1 session binding — UPSERT on cli_session_id, no history.
async function linkSession(uuid, sessionId, cwd) {
  if (!uuid || !sessionId) return;

  const pool = postgres.getPool();
  if (!pool) return;

  try {
    // Ensure identity row exists (agents registered before PG was up).
    await pool.query(
      `INSERT INTO identity_index (cli_session_id, agent_name, workspace, role)
       VALUES ($1, $2, $3, 'worker')
       ON CONFLICT (cli_session_id) DO NOTHING`,
      [uuid, uuid.slice(0, 8), 'boos']
    );

    // 1:1 UPSERT — replaces any previous session for this agent.
    await pool.query(
      `INSERT INTO agent_sessions (cli_session_id, boos_session_id, cwd, updated_at)
       VALUES ($1, $2, $3, datetime("now"))
       ON CONFLICT (cli_session_id) DO UPDATE SET
         boos_session_id = EXCLUDED.boos_session_id,
         cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
         updated_at = datetime("now")`,
      [uuid, sessionId, cwd || null]
    );

    if (cwd) {
      await pool.query(
        'UPDATE identity_index SET cwd = $1, updated_at = datetime("now") WHERE cli_session_id = $2',
        [cwd, uuid]
      );
    }
  } catch (e) {
    console.warn('[identityAdapter] linkSession failed:', e.message);
  }
}

async function unlinkSession(sessionId) {
  if (!sessionId) return;

  const pool = postgres.getPool();
  if (!pool) return;

  try {
    await pool.query(
      'DELETE FROM agent_sessions WHERE boos_session_id = $1',
      [sessionId]
    );
  } catch (e) {
    console.warn('[identityAdapter] unlinkSession failed:', e.message);
  }
}

async function onSessionExited(sessionId) {
  if (!sessionId) return;

  const pool = postgres.getPool();
  if (!pool) return;

  try {
    await pool.query(
      `UPDATE identity_index SET pty_pid = 0, updated_at = datetime("now")
       WHERE cli_session_id IN (
         SELECT cli_session_id FROM agent_sessions WHERE boos_session_id = $1
       )`,
      [sessionId]
    );
  } catch (e) {
    console.warn('[identityAdapter] onSessionExited failed:', e.message);
  }
}

// ── Seed: migrate from agent-bus.json + persistedSessions.json → PG ─────

async function syncFromJson() {
  const pool = postgres.getPool();
  if (!pool) return 0;

  let count = 0;
  try {
    const storeCore = require('./agentBus/storeCore');
    const db = storeCore._syncLoad();
    const identities = db.identities || {};

    for (const [uid, ident] of Object.entries(identities)) {
      if (!ident.name) continue;

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid);
      if (!isUuid) continue;

      await pool.query(
        `INSERT INTO identity_index (cli_session_id, agent_name, workspace, role, capabilities, mcp_session_id, pty_pid, cwd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (cli_session_id) DO UPDATE SET
           agent_name = EXCLUDED.agent_name,
           workspace = EXCLUDED.workspace,
           role = EXCLUDED.role,
           mcp_session_id = COALESCE(EXCLUDED.mcp_session_id, identity_index.mcp_session_id),
           pty_pid = COALESCE(EXCLUDED.pty_pid, identity_index.pty_pid),
           cwd = COALESCE(EXCLUDED.cwd, identity_index.cwd),
           updated_at = datetime("now")`,
        [
          uid, ident.name, ident.workspace || 'boos', ident.role || 'worker',
          ident.capabilities || [],
          ident.mcp_session_id && ident.mcp_session_id !== '__unbound__' ? ident.mcp_session_id : null,
          ident.pty_pid || 0,
          ident.cwd && ident.cwd !== '__pending__' ? ident.cwd : null,
        ]
      );

      // 1:1 session binding (only the current one from persistedSessions wins).
      if (ident.boos_session_id && ident.boos_session_id !== '__pending__') {
        await pool.query(
          `INSERT INTO agent_sessions (cli_session_id, boos_session_id, cwd, updated_at)
           VALUES ($1, $2, $3, datetime("now"))
           ON CONFLICT (cli_session_id) DO UPDATE SET
             boos_session_id = EXCLUDED.boos_session_id,
             cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
             updated_at = datetime("now")`,
          [uid, ident.boos_session_id, ident.cwd && ident.cwd !== '__pending__' ? ident.cwd : null]
        );
      }

      count++;
    }

    // Also seed sessions from persistedSessions.json (authoritative for session→UUID).
    try {
      const ps = require('./persistedSessions');
      const all = await ps.loadAll();
      for (const s of all) {
        if (!s.cliSessionId || !s.id) continue;
        await pool.query(
          `INSERT INTO identity_index (cli_session_id, agent_name, workspace, role)
           VALUES ($1, $2, 'boos', 'worker')
           ON CONFLICT (cli_session_id) DO NOTHING`,
          [s.cliSessionId, s.title || s.cliSessionId.slice(0, 8)]
        );
        // 1:1 UPSERT — running sessions win.
        await pool.query(
          `INSERT INTO agent_sessions (cli_session_id, boos_session_id, cwd, updated_at)
           VALUES ($1, $2, $3, datetime("now"))
           ON CONFLICT (cli_session_id) DO UPDATE SET
             boos_session_id = COALESCE(EXCLUDED.boos_session_id, agent_sessions.boos_session_id),
             cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
             updated_at = datetime("now")
           WHERE agent_sessions.boos_session_id IS NULL`,
          [s.cliSessionId, s.id, s.cwd || null]
        );
      }
    } catch (e) {
      console.warn('[identityAdapter] session seed failed:', e.message);
    }

    if (count > 0) {
      console.log('[identityAdapter] synced', count, 'UUID identities from JSON → SQLite');
    }
  } catch (e) {
    console.warn('[identityAdapter] syncFromJson failed:', e.message);
  }
  return count;
}

// ── Migration: upgrade old schema → strict 1:1 ─────────────────────────

async function _migrateDDL(pool) {
  // Check if agent_sessions has the old schema (is_current column).
  try {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agent_sessions' AND column_name = 'is_current'`
    );
    if (r.rows.length > 0) {
      console.log('[identityAdapter] migrating agent_sessions: 1:N → 1:1');
      // Drop old table + recreate with new schema.
      await pool.query('DROP TABLE IF EXISTS agent_sessions CASCADE');
      await pool.query(`
        CREATE TABLE agent_sessions (
          cli_session_id  TEXT PRIMARY KEY REFERENCES identity_index ON DELETE CASCADE,
          boos_session_id TEXT NOT NULL UNIQUE,
          cwd             TEXT,
          updated_at      TIMESTAMPTZ DEFAULT datetime("now")
        )
      `);
      console.log('[identityAdapter] agent_sessions recreated (strict 1:1)');
    }
  } catch (e) {
    console.warn('[identityAdapter] migration check failed:', e.message);
  }

  // Ensure UNIQUE constraints on identity_index (old indexes were non-UNIQUE).
  try {
    const r = await pool.query(
      `SELECT conname, contype FROM pg_constraint
       WHERE conrelid = 'identity_index'::regclass AND contype = 'u'`
    );
    const names = new Set(r.rows.map(r => r.conname));

    if (!names.has('identity_index_mcp_session_id_key')) {
      await pool.query(
        `ALTER TABLE identity_index ADD CONSTRAINT identity_index_mcp_session_id_key UNIQUE (mcp_session_id)`
      ).catch(() => {}); // may already exist from DDL recreate
    }
    if (!names.has('identity_index_agent_name_workspace_key')) {
      await pool.query(
        `ALTER TABLE identity_index ADD CONSTRAINT identity_index_agent_name_workspace_key UNIQUE (agent_name, workspace)`
      ).catch(() => {});
    }
  } catch (e) {
    console.warn('[identityAdapter] UNIQUE constraint migration:', e.message);
  }
}

// ── Fallback: agent-bus.json (when PG unavailable) ──────────────────────

function _resolveFromJson(uuid, name, workspace) {
  try {
    const storeCore = require('./agentBus/storeCore');
    const db = storeCore._syncLoad();
    let uid = uuid;

    if (!uid && name) {
      uid = db.identity_by_name_ws[name + '|' + (workspace || 'boos')] || null;
    }

    if (!uid) return null;

    const ident = db.identities[uid];
    if (!ident) return null;

    return _rowToIdentity({
      cli_session_id: uid,
      agent_name: ident.name || '',
      workspace: ident.workspace || 'boos',
      role: ident.role || 'worker',
      capabilities: ident.capabilities || [],
      mcp_session_id: ident.mcp_session_id || null,
      pty_pid: ident.pty_pid || 0,
      cwd: ident.cwd || null,
      boos_session_id: ident.boos_session_id !== '__pending__' ? ident.boos_session_id : null,
      registered_at: ident.updated_at,
      updated_at: ident.updated_at,
    });
  } catch (e) {
    console.warn('[identityAdapter] _resolveFromJson failed:', e.message);
    return null;
  }
}

function _resolveFromJsonBySession(sessionId) {
  try {
    const storeCore = require('./agentBus/storeCore');
    const db = storeCore._syncLoad();
    for (const [uid, ident] of Object.entries(db.identities || {})) {
      if (ident.boos_session_id === sessionId) {
        return _resolveFromJson(uid);
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function _resolveFromJsonByMcp(mcpSessionId) {
  try {
    const storeCore = require('./agentBus/storeCore');
    const db = storeCore._syncLoad();
    const uid = db.identity_by_mcp_session[mcpSessionId];
    if (uid) return _resolveFromJson(uid);
    return null;
  } catch (e) {
    return null;
  }
}

function _writeToJson(uuid, fields) {
  try {
    const { writeIdentity } = require('./agentBus/storeIdentity');
    return writeIdentity(uuid, fields);
  } catch (e) {
    return null;
  }
}

// ── DDL injection (called by postgres.js during ensureContainer) ────────

async function runDDL(pool) {
  try {
    await pool.query(IDENTITY_DDL);
    console.log('[identityAdapter] DDL applied (identity_index + agent_sessions, strict 1:1)');
    // Run migration for existing containers with old schema.
    await _migrateDDL(pool);
    return true;
  } catch (e) {
    console.warn('[identityAdapter] DDL failed:', e.message);
    return false;
  }
}

module.exports = {
  IDENTITY_DDL,
  runDDL,
  resolve,
  resolveByName,
  resolveBySession,
  resolveByMcp,
  upsert,
  linkSession,
  unlinkSession,
  onSessionExited,
  syncFromJson,
};

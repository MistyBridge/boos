// Identity card system + session/deprecated wrappers for agent-bus store.
//
// Sprint 33: JSON identity card → { name, workspace, updated_at } ONLY.
// NO routing fields stored in card body — mcp_session_id, pty_pid, cwd, sessions
// are authoritative in PostgreSQL identity_index + agent_sessions (all strict 1:1).
// JSON identity_by_mcp_session index is maintained separately (not in card body)
// for sync dispatch fallback when PG is down.
//
// Imported and re-exported by store.js. Uses storeCore (no circular require).

'use strict';

const { _load, _syncLoad, _save, DB_PATH, withFileLock, atomicWriteJson } = require('./storeCore');

const ROOT_UID = 'agent_root';

async function resolveSessionForAgent(agentUid) {
  if (!agentUid || typeof agentUid !== 'string') return null;
  try {
    const { findByCliSessionId } = require('../persistedSessions');
    const session = await findByCliSessionId(agentUid);
    if (session) return session.id;
    const { loadAll } = require('../persistedSessions');
    const all = await loadAll();
    const match = all.find((s) => s.agentUid === agentUid && !s.deletedAt);
    if (match) return match.id;
    const direct = all.find((s) => s.id === agentUid && !s.deletedAt);
    if (direct) return direct.id;
    return null;
  } catch { return null; }
}

// ── JSON identity card write (Sprint 33: name + workspace only) ──────────

async function writeIdentity(agentUid, fields) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const existing = db.identities[agentUid] || {};
    // Sprint 33: JSON card → name + workspace ONLY. Never spread old fields.
    const merged = {
      name: fields.name !== undefined ? fields.name : existing.name,
      workspace: fields.workspace !== undefined ? fields.workspace : existing.workspace,
      updated_at: new Date().toISOString(),
    };
    db.identities[agentUid] = merged;

    // name|workspace ↔ uid index.
    const name = merged.name || existing.name;
    const ws = merged.workspace || existing.workspace;
    if (name && ws) db.identity_by_name_ws[name + '|' + ws] = agentUid;

    // mcp_session_id → JSON index only (sync dispatch fallback).
    // Card body does NOT store mcp_session_id — PG is authoritative.
    if (fields.mcp_session_id !== undefined) {
      const newMcp = fields.mcp_session_id;
      // Scan old mcp→uid mappings for this agent and clean them.
      for (const [key, val] of Object.entries(db.identity_by_mcp_session)) {
        if (val === agentUid) delete db.identity_by_mcp_session[key];
      }
      if (newMcp && newMcp !== '__pending__' && newMcp !== '__unbound__') {
        db.identity_by_mcp_session[newMcp] = agentUid;
      }
      // Sync to PG (authoritative source).
      try {
        const adapter = require('../identityAdapter');
        await adapter.upsert(agentUid, { mcp_session_id: newMcp || null });
      } catch { /* PG optional */ }
    }

    await _save(db);
    return merged;
  });
}

async function rebuildAllIndices() {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    db.identity_by_mcp_session = {};
    db.identity_by_name_ws = {};
    for (const [uid, ident] of Object.entries(db.identities || {})) {
      if (ident.name && ident.workspace) {
        db.identity_by_name_ws[ident.name + '|' + ident.workspace] = uid;
      }
    }
    // Rebuild mcp→uid index: PG-only (card body no longer stores mcp_session_id).
    let mcpFromPg = 0;
    try {
      const { query } = require('../postgres');
      const r = await query(
        'SELECT cli_session_id, mcp_session_id FROM identity_index WHERE mcp_session_id IS NOT NULL'
      );
      if (r?.rows) {
        for (const row of r.rows) {
          if (row.mcp_session_id) {
            db.identity_by_mcp_session[row.mcp_session_id] = row.cli_session_id;
            mcpFromPg++;
          }
        }
      }
    } catch { /* PG unavailable */ }
    await _save(db);
    const count = Object.keys(db.identities || {}).length;
    console.log('[agent-bus] rebuildAllIndices:', count, 'identities →',
      Object.keys(db.identity_by_mcp_session).length, 'mcp (' + mcpFromPg + ' from PG),',
      Object.keys(db.identity_by_name_ws).length, 'name_ws entries');
    return count;
  });
}

// ── Read (sync, degradation-only) ──────────────────────────────────────

async function upsertIdentity(agentUid, fields) {
  return writeIdentity(agentUid, fields);
}

function getIdentity(query) {
  // Sprint 33: JSON card → { agent_uid, name, workspace } only.
  // All routing fields → PG adapter.resolve().
  const db = _syncLoad();
  let uid = null;
  if (query.uid) {
    uid = query.uid;
  } else if (query.name && query.workspace) {
    uid = db.identity_by_name_ws[query.name + '|' + query.workspace];
  } else if (query.name) {
    for (const [key, v] of Object.entries(db.identity_by_name_ws || {})) {
      if (key.startsWith(query.name + '|')) { uid = v; break; }
    }
  }
  if (uid && db.identities[uid]) {
    return { agent_uid: uid, name: db.identities[uid].name, workspace: db.identities[uid].workspace };
  }
  return null;
}

// Sprint 33: removed — boos_session_id is no longer in JSON.
// Use adapter.resolveBySession() for PG-authoritative lookups.
function getIdentityByBoosSession(sessionId) {
  // Legacy compat: scan old cards that may still have boos_session_id.
  if (!sessionId) return null;
  const db = _syncLoad();
  for (const [uid, ident] of Object.entries(db.identities || {})) {
    if (ident.boos_session_id === sessionId) return { uid, ...ident };
  }
  return null;
}

// ── Session lifecycle ──────────────────────────────────────────────────

async function onSessionExited(sessionId) {
  if (!sessionId) return;
  // PG adapter: clear pty_pid in identity_index.
  try {
    const adapter = require('../identityAdapter');
    await adapter.onSessionExited(sessionId);
  } catch {}
  // JSON identity card no longer stores pty_pid — nothing to clear.
}

async function linkIdentityToSession(agentUid, sessionId, cwd, ptyPid) {
  if (!agentUid || !sessionId) return;
  // Sprint 33: PG is authoritative for session binding.
  // JSON card stores only name+workspace — no session fields.
  try {
    const adapter = require('../identityAdapter');
    await adapter.linkSession(agentUid, sessionId, cwd);
  } catch {}
}

// ── MCP transport binding ──────────────────────────────────────────────

async function bindMcpSession(mcpSessionId, agentUid) {
  // Write to PG adapter + JSON mcp index (degradation fallback).
  try {
    const adapter = require('../identityAdapter');
    await adapter.upsert(agentUid, { mcp_session_id: mcpSessionId });
  } catch {}
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const oldMcp = db.identity_by_mcp_session[mcpSessionId];
    if (oldMcp && oldMcp !== agentUid) {
      // Steal from old agent.
    }
    // Clean old mcp→uid mapping for this agent before writing new one.
    for (const [key, val] of Object.entries(db.identity_by_mcp_session)) {
      if (val === agentUid) delete db.identity_by_mcp_session[key];
    }
    db.identity_by_mcp_session[mcpSessionId] = agentUid;
    // Card body does NOT store mcp_session_id — index only.
    await _save(db);
    return db.identities[agentUid];
  });
}

async function unbindMcpSession(mcpSessionId) {
  if (!mcpSessionId) return;
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const uid = db.identity_by_mcp_session[mcpSessionId];
    delete db.identity_by_mcp_session[mcpSessionId];
    // Card body does NOT store mcp_session_id — index only.
    await _save(db);
  });
}

function getAgentUidByMcpSession(mcpSessionId) {
  // Degradation fallback: reads from cached JSON mcp index.
  return _syncLoad().identity_by_mcp_session[mcpSessionId] || null;
}

function autoResolveIdentity(mcpSessionId) {
  if (!mcpSessionId) return null;
  const db = _syncLoad();
  let uid = db.identity_by_mcp_session[mcpSessionId];
  if (!uid) {
    const sessions = db.sessions || {};
    uid = sessions[mcpSessionId] || null;
  }
  // PG authoritative fallback: when JSON index is stale (agent reconnected
  // with new MCP session), query PG identity_index then fix the JSON index.
  if (!uid) {
    try {
      const { query } = require('../postgres');
      uid = _pgLookupMcp(query, mcpSessionId);
      if (uid) {
        db.identity_by_mcp_session[mcpSessionId] = uid;
        const { atomicWriteJson } = require('../atomicJson');
        atomicWriteJson(DB_PATH, db);
        console.log('[agent-bus] autoResolveIdentity: PG fallback resolved', uid.slice(-8), 'for mcp session', mcpSessionId.slice(-12));
      }
    } catch { /* PG not available */ }
  }
  if (!uid) return null;
  const ident = db.identities[uid];
  if (ident) return { uid, identity: { agent_uid: uid, name: ident.name, workspace: ident.workspace } };
  return null;
}

function _pgLookupMcp(queryFn, mcpSessionId) {
  // Cannot await in sync context — use a sync pattern.
  // The PG query must be run synchronously, which postgres.js supports
  // only via the pool's sync methods. We use a lightweight approach:
  // check if PG has an in-memory cache of the identity_index.
  try {
    const pg = require('../postgres');
    if (pg._identityCache && pg._identityCache[mcpSessionId]) {
      return pg._identityCache[mcpSessionId];
    }
  } catch {}
  return null;
}

function isRootAgent(uid) {
  const agent = _syncLoad().agents[uid];
  return agent && agent.role === 'root';
}

// ── Bootstrap ──────────────────────────────────────────────────────────

async function bootstrapIdentities() {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    let rebuilt = 0;
    for (const [uid, agent] of Object.entries(db.agents)) {
      if (!db.identities[uid]) {
        db.identities[uid] = {
          name: agent.name, workspace: agent.workspace,
          updated_at: new Date().toISOString(),
        };
        if (agent.name && agent.workspace) {
          db.identity_by_name_ws[agent.name + '|' + agent.workspace] = uid;
        }
        rebuilt++;
      }
    }
    if (rebuilt > 0) {
      await _save(db);
      console.log('[agent-bus] bootstrapIdentities: rebuilt', rebuilt, 'identity card(s)');
    }
    return rebuilt;
  });
}

module.exports = {
  ROOT_UID,
  resolveSessionForAgent,
  writeIdentity, rebuildAllIndices,
  upsertIdentity, getIdentity,
  onSessionExited, linkIdentityToSession,
  bindMcpSession, unbindMcpSession, getAgentUidByMcpSession,
  autoResolveIdentity, isRootAgent,
  getIdentityByBoosSession,
  bootstrapIdentities,
};

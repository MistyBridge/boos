// Identity card system + session/deprecated wrappers for agent-bus store.
//
// Identity cards cross-reference: agent UID ↔ BOOS session ID ↔ MCP session ID
// ↔ name+workspace.  writeIdentity() is the single canonical write path (Sprint 22).
// All three reverse indices updated atomically inside withFileLock.
//
// Imported and re-exported by store.js. Uses storeCore (no circular require).

'use strict';

const { _load, _syncLoad, _save, DB_PATH, withFileLock, atomicWriteJson } = require('./storeCore');

const ROOT_UID = 'agent_root';

const REQUIRED_IDENTITY_FIELDS = [
  'agent_uid', 'name', 'workspace', 'role',
  'boos_session_id', 'mcp_session_id', 'cwd',
  'pty_pid', 'updated_at',
];

function validateIdentity(identity) {
  if (!identity) return { ok: false, missing: ['(identity is null)'] };
  if (identity.agent_uid === ROOT_UID) return { ok: true, missing: [] };
  const missing = [];
  for (const f of REQUIRED_IDENTITY_FIELDS) {
    const v = identity[f];
    if (v === null || v === undefined || v === '') missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

async function resolveBoosSessionForAgent(agentUid) {
  if (!agentUid || typeof agentUid !== 'string') return null;
  try {
    const { loadAll } = require('../persistedSessions');
    const all = await loadAll();
    const alive = all.filter((s) => !s.deletedAt);
    const db = _syncLoad();
    const ident = db.identities[agentUid];
    if (ident?.boos_session_id) {
      const match = alive.find((s) => s.id === ident.boos_session_id);
      if (match) return match.id;
    }
    const match = alive.find((s) => s.agentUid === agentUid);
    if (match) return match.id;
    return null;
  } catch { return null; }
}

// ── Canonical identity write (Sprint 22) ────────────────────────────────

async function writeIdentity(agentUid, fields) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const existing = db.identities[agentUid] || {};
    const merged = { ...existing, agent_uid: agentUid };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) merged[k] = v;
    }
    merged.updated_at = new Date().toISOString();
    db.identities[agentUid] = merged;

    // boos_session_id ↔ uid
    const oldBoos = existing.boos_session_id;
    const newBoos = merged.boos_session_id;
    if (newBoos !== oldBoos) {
      if (oldBoos && oldBoos !== '__pending__') delete db.identity_by_boos_session[oldBoos];
      if (newBoos && newBoos !== '__pending__') db.identity_by_boos_session[newBoos] = agentUid;
    }
    // mcp_session_id ↔ uid
    const oldMcp = existing.mcp_session_id;
    const newMcp = merged.mcp_session_id;
    if (newMcp !== oldMcp) {
      if (oldMcp && oldMcp !== '__pending__') delete db.identity_by_mcp_session[oldMcp];
      if (newMcp && newMcp !== '__pending__') db.identity_by_mcp_session[newMcp] = agentUid;
    }
    // name|workspace ↔ uid
    const name = merged.name || existing.name;
    const ws = merged.workspace || existing.workspace;
    if (name && ws) db.identity_by_name_ws[name + '|' + ws] = agentUid;

    await _save(db);
    return merged;
  });
}

async function rebuildAllIndices() {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    db.identity_by_boos_session = {};
    db.identity_by_mcp_session = {};
    db.identity_by_name_ws = {};
    for (const [uid, ident] of Object.entries(db.identities || {})) {
      if (ident.boos_session_id && ident.boos_session_id !== '__pending__') {
        db.identity_by_boos_session[ident.boos_session_id] = uid;
      }
      if (ident.mcp_session_id && ident.mcp_session_id !== '__pending__') {
        db.identity_by_mcp_session[ident.mcp_session_id] = uid;
      }
      if (ident.name && ident.workspace) {
        db.identity_by_name_ws[ident.name + '|' + ident.workspace] = uid;
      }
    }
    await _save(db);
    const count = Object.keys(db.identities || {}).length;
    console.log('[agent-bus] rebuildAllIndices:', count, 'identities →',
      Object.keys(db.identity_by_boos_session).length, 'boos,',
      Object.keys(db.identity_by_mcp_session).length, 'mcp,',
      Object.keys(db.identity_by_name_ws).length, 'name_ws entries');
    return count;
  });
}

// ── @deprecated wrappers (delegate to writeIdentity) ────────────────────

async function upsertIdentity(agentUid, fields) {
  return writeIdentity(agentUid, fields);
}

function getIdentity(query) {
  const db = _syncLoad();
  let uid = null;
  if (query.uid) {
    uid = query.uid;
  } else if (query.boosSessionId) {
    uid = db.identity_by_boos_session[query.boosSessionId];
  } else if (query.name && query.workspace) {
    uid = db.identity_by_name_ws[query.name + '|' + query.workspace];
  } else if (query.name) {
    for (const [key, v] of Object.entries(db.identity_by_name_ws || {})) {
      if (key.startsWith(query.name + '|')) { uid = v; break; }
    }
  }
  if (uid && db.identities[uid]) return { ...db.identities[uid] };
  return null;
}

function getIdentityByBoosSession(sessionId) {
  return getIdentity({ boosSessionId: sessionId });
}

async function linkIdentityToSession(agentUid, sessionId, cwd, ptyPid) {
  if (!agentUid || !sessionId) return;
  return writeIdentity(agentUid, {
    boos_session_id: sessionId, cwd: cwd || undefined,
    pty_pid: typeof ptyPid === 'number' ? ptyPid : undefined,
  });
}

async function onSessionExited(sessionId) {
  if (!sessionId) return;
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const uid = db.identity_by_boos_session[sessionId];
    if (!uid || !db.identities[uid]) return;
    db.identities[uid].pty_pid = 0;
    db.identities[uid].updated_at = new Date().toISOString();
    await _save(db);
  });
}

async function bindMcpSession(mcpSessionId, agentUid) {
  return writeIdentity(agentUid, { mcp_session_id: mcpSessionId });
}

async function unbindMcpSession(mcpSessionId) {
  if (!mcpSessionId) return;
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const uid = db.identity_by_mcp_session[mcpSessionId];
    delete db.identity_by_mcp_session[mcpSessionId];
    if (uid && db.identities[uid]) {
      db.identities[uid].mcp_session_id = null;
      db.identities[uid].updated_at = new Date().toISOString();
    }
    await _save(db);
  });
}

function getAgentUidByMcpSession(mcpSessionId) {
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
  if (!uid || !db.identities[uid]) return null;
  return { uid, identity: db.identities[uid] };
}

function isRootAgent(uid) {
  const agent = _syncLoad().agents[uid];
  return agent && agent.role === 'root';
}

// ── Bootstrap ────────────────────────────────────────────────────────────

async function bootstrapIdentities() {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    let rebuilt = 0;
    for (const [uid, agent] of Object.entries(db.agents)) {
      if (!db.identities[uid]) {
        db.identities[uid] = {
          agent_uid: uid, name: agent.name, workspace: agent.workspace,
          role: agent.role || 'worker', updated_at: new Date().toISOString(),
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
  ROOT_UID, REQUIRED_IDENTITY_FIELDS,
  validateIdentity, resolveBoosSessionForAgent,
  writeIdentity, rebuildAllIndices,
  upsertIdentity, getIdentity, getIdentityByBoosSession,
  linkIdentityToSession, onSessionExited,
  bindMcpSession, unbindMcpSession, getAgentUidByMcpSession,
  autoResolveIdentity, isRootAgent,
  bootstrapIdentities,
};

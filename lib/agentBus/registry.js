// Agent registry — idempotent registration, discovery, and heartbeat.
//
// Adapted from agent-bus/lib/registry.js. Changed: require('./store') path.

'use strict';

const store = require('./store');
const { validateWorkspace } = require('./workspace');

function registerAgent({ name, intro, workspace, role, capabilities }) {
  if (!name || !workspace) {
    return { ok: false, error: 'name and workspace are required' };
  }

  const wsCheck = validateWorkspace(workspace);
  if (!wsCheck.valid) return { ok: false, error: wsCheck.reason };

  const cleanName = name.slice(0, 64);
  const cleanIntro = (intro || '').slice(0, 256);
  const cleanRole = role === 'supervisor' ? 'supervisor' : 'worker';
  const cleanCapabilities = Array.isArray(capabilities) ? capabilities.slice(0, 10) : [];

  const existing = store.findAgentByNameWs(cleanName, workspace);

  if (existing) {
    store.touchAgent(existing.uid);
    const pendingCount = store.countPendingTasks(existing.uid);
    return {
      ok: true,
      uid: existing.uid,
      reconnected: true,
      pending_tasks: pendingCount,
      registered_at: existing.registered_at,
    };
  }

  const uid = _generateUid();
  store.insertAgent({
    uid,
    name: cleanName,
    intro: cleanIntro,
    workspace,
    role: cleanRole,
    capabilities: cleanCapabilities,
  });

  return { ok: true, uid, reconnected: false, pending_tasks: 0 };
}

function deregisterAgent(uid) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: true, existed: false };

  const sessionCount = store.countAgentSessions(uid);
  if (sessionCount > 0) {
    return { ok: false, existed: true, active_sessions: sessionCount,
      error: 'agent has ' + sessionCount + ' active session(s)' };
  }

  store.deleteAgent(uid);
  return { ok: true, existed: true };
}

function forceDeregisterAgent(uid) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: true, existed: false };
  store.deleteAgent(uid);
  return { ok: true, existed: true };
}

function getAgent(uid) {
  return store.getAgent(uid);
}

function listAgentsInWorkspace(workspace, opts = {}) {
  // Disabled: agents never go offline by default.
// Pass { staleThresholdMs: <ms> } to re-enable heartbeat-based filtering.
const threshold = opts.staleThresholdMs || Number.MAX_SAFE_INTEGER;
  const cutoff = new Date(Date.now() - threshold).toISOString();
  const all = store.listAgentsInWorkspace(workspace);

  if (opts.includeStale) return all;

  return all.filter((a) => a.last_seen_at >= cutoff);
}

function listAllAgentsInWorkspace(workspace) {
  return store.listAllAgentsInWorkspace(workspace);
}

function touchAgent(uid) {
  store.touchAgent(uid);
}

// ── internal ──────────────────────────────────────────────────────────

function _generateUid() {
  return 'agent_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  registerAgent, deregisterAgent, forceDeregisterAgent,
  getAgent, listAgentsInWorkspace, listAllAgentsInWorkspace, touchAgent,
};

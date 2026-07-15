// Agent registry — idempotent registration, discovery, and heartbeat.
//
// Adapted from agent-bus/lib/registry.js. Changed: require('./store') path.

'use strict';

const store = require('./store');
const { validateWorkspace } = require('./workspace');

async function registerAgent({ name, intro, workspace, role, capabilities, project, _internalRegister }) {
  if (!name || !workspace) {
    return { ok: false, error: 'name and workspace are required' };
  }

  const wsCheck = validateWorkspace(workspace);
  if (!wsCheck.valid) return { ok: false, error: wsCheck.reason };

  const cleanName = name.slice(0, 64);
  const cleanIntro = (intro || '').slice(0, 256);
  const cleanRole = (() => {
    if (role === 'root') return 'root';
    if (role === 'supervisor') return 'supervisor';
    return 'worker';
  })();
  const cleanCapabilities = Array.isArray(capabilities) ? capabilities.slice(0, 10) : [];
  const cleanProject = (project || '').slice(0, 64) || null;

  // Sprint 13: root role is reserved for system agents only.
  if (cleanRole === 'root' && !_internalRegister) {
    return { ok: false, error: 'root role is reserved for system agents' };
  }

  const existing = store.findAgentByNameWs(cleanName, workspace);

  if (existing) {
    await store.touchAgent(existing.uid);
    // Update project if agent was previously unassigned and now has one.
    if (cleanProject && !existing.project) {
      await store.setAgentProject(existing.uid, cleanProject);
    }
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
  await store.insertAgent({
    uid,
    name: cleanName,
    intro: cleanIntro,
    workspace,
    role: cleanRole,
    capabilities: cleanCapabilities,
    project: cleanProject,
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
  const all = store.listAgentsInWorkspace(workspace, { project: opts.project });

  if (opts.includeStale) return all;

  // Disabled: agents never go offline by default.
  // Pass { staleThresholdMs: <ms> } to re-enable heartbeat-based filtering.
  if (!opts.staleThresholdMs) return all;

  const cutoff = new Date(Date.now() - opts.staleThresholdMs).toISOString();
  return all.filter((a) => a.last_seen_at >= cutoff);
}

function listAllAgentsInWorkspace(workspace) {
  return store.listAllAgentsInWorkspace(workspace);
}

function touchAgent(uid) {
  store.touchAgent(uid);
}

// ── PM identity system (Sprint 8 Wave 1) ──────────────────────────────

async function setProjectPM(uid, projects, requesterUid) {
  const target = store.getAgent(uid);
  if (!target) return { ok: false, error: 'agent not found: ' + uid };
  const requester = store.getAgent(requesterUid);
  if (!requester || requester.role !== 'supervisor') {
    return { ok: false, error: 'only workspace supervisor can set PM' };
  }
  await store.setAgentPM(uid, projects);
  return { ok: true, uid, pm_of: projects };
}

async function assignToProject(uid, project, requesterUid) {
  const target = store.getAgent(uid);
  if (!target) return { ok: false, error: 'agent not found: ' + uid };
  const requester = store.getAgent(requesterUid);
  if (!requester) return { ok: false, error: 'requester not found' };
  // Supervisor or PM of the target project can assign.
  if (requester.role !== 'supervisor' && !store.isPMOf(requester, project)) {
    return { ok: false, error: 'only supervisor or project PM can assign agents to a project' };
  }
  await store.setAgentProject(uid, project);
  return { ok: true, uid, project };
}

// Sprint 13: Root Agent — permanent human↔agent communication bridge.
// Uses a fixed UID so the frontend and other agents can reference it.
const ROOT_UID = 'agent_root';

async function registerRootAgent({ name, intro }) {
  const existing = store.getAgent(ROOT_UID);
  if (existing) {
    await store.touchAgent(ROOT_UID);
    return { ok: true, uid: ROOT_UID, name: existing.name, reconnected: true };
  }
  await store.insertAgent({
    uid: ROOT_UID,
    name: name || 'BOOS Root',
    intro: intro || 'BOOS 系统根代理 — 人类与 Agent 之间的通信桥梁',
    workspace: '*',
    role: 'root',
    capabilities: ['root', 'human_interface'],
  });
  return { ok: true, uid: ROOT_UID, name: name || 'BOOS Root', reconnected: false };
}

// ── internal ──────────────────────────────────────────────────────────

function _generateUid() {
  return 'agent_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  registerAgent, deregisterAgent, forceDeregisterAgent,
  getAgent, listAgentsInWorkspace, listAllAgentsInWorkspace, touchAgent,
  setProjectPM, assignToProject,
  registerRootAgent, ROOT_UID,
};

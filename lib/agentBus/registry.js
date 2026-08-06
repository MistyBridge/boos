// Agent registry — idempotent registration, discovery, and heartbeat.
//
// Sprint 33: cliSessionId (Claude --resume UUID) is the ONE true agent UID.
// No more agent_xxx hashes, sess-xxx mappings, or boos_session_id bridging.
// name/workspace/role are metadata only — never used for identity routing.
//
// Adapted from agent-bus/lib/registry.js. Changed: require('./store') path.

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const store = require('./store');
const { validateWorkspace } = require('./workspace');

async function registerAgent({ name, intro, workspace, role, capabilities, project,
                                cliSessionId, _internalRegister }) {
  if (!name || !workspace) {
    return { ok: false, error: 'name and workspace are required' };
  }

  // Sprint 33: cliSessionId is REQUIRED for non-root agents.
  // This IS the agent's uid — no fallbacks, no hash generation.
  if (!cliSessionId && !_internalRegister) {
    return { ok: false, error: 'cli_session_id is required — it IS your uid (Claude --resume UUID)' };
  }

  const wsCheck = validateWorkspace(workspace);
  if (!wsCheck.valid) return { ok: false, error: wsCheck.reason };

  // Sprint 42: workspace must already exist UNLESS the caller is a
  // supervisor (PM) or root — only PMs may create new workspaces; workers
  // must choose an existing one. Auto-registration (system path) must not
  // create new workspaces either (transport's fallback chain handles that).
  const wsExists = store.listAllAgents().some((a) => a.workspace === workspace);
  const canCreate = role === 'supervisor' || role === 'root';
  if (!wsExists && !canCreate) {
    return {
      ok: false,
      error: `workspace "${workspace}" does not exist — only PM (supervisor) may create workspaces; workers must choose an existing workspace`,
    };
  }

  const cleanName = name.slice(0, 64);
  const cleanIntro = (intro || '').slice(0, 256);
  const cleanRole = (() => {
    if (role === 'root') return 'root';
    if (role === 'supervisor') return 'supervisor';
    if (role === 'pmo') return 'pmo';
    return 'worker';
  })();
  const cleanCapabilities = Array.isArray(capabilities) ? capabilities.slice(0, 10) : [];
  const cleanProject = (project || '').slice(0, 64) || null;

  // Sprint 13: root role is reserved for system agents only.
  if (cleanRole === 'root' && !_internalRegister) {
    return { ok: false, error: 'root role is reserved for system agents' };
  }

  // uid = cliSessionId, always.
  const uid = cliSessionId || ROOT_UID;

  // 1:1 per cliSessionId — if already registered, reconnect.
  const existingByUid = store.getAgent(uid);
  if (existingByUid) {
    await store.touchAgent(uid);
    if (cleanProject && !existingByUid.project) {
      await store.setAgentProject(uid, cleanProject);
    }
    return {
      ok: true, uid, reconnected: true,
      pending_tasks: await store.countPendingTasks(uid),
      registered_at: existingByUid.registered_at,
    };
  }

  // Find by name+workspace — old records under a different uid get migrated.
  const existingByName = store.findAgentByNameWs(cleanName, workspace);
  if (existingByName && existingByName.uid !== uid) {
    const migration = await store.migrateAgentUid(existingByName.uid, uid);
    if (migration.ok && migration.migrated) {
      await store.touchAgent(uid);
      if (cleanProject && !existingByName.project) {
        await store.setAgentProject(uid, cleanProject);
      }
      console.log('[agent-bus] registry: migrated', existingByName.uid, '→', uid, '(', cleanName, ')');
      return {
        ok: true, uid, reconnected: true,
        pending_tasks: await store.countPendingTasks(uid),
        registered_at: existingByName.registered_at,
        migrated: true, old_uid: existingByName.uid,
      };
    }
    console.warn('[agent-bus] registry: migration failed for', existingByName.uid, '→', uid);
  }

  // New registration.
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

  // Sprint 39: clean up the agent's inbox file on deregistration.
  // Since Sprint 35, tasks live exclusively in per-agent inbox files.
  // Removing the inbox file prevents phantom activeTasks counts.
  try {
    const inboxStore = require('./inboxStore');
    const fs = require('fs');
    const path = require('path');
    const errReport = require("../errorReport");
    const inboxPath = path.join(inboxStore.INBOX_DIR, `${uid}.json`);
    if (fs.existsSync(inboxPath)) {
      const inbox = inboxStore.loadInboxSync(uid);
      const total = inbox.pending.length + inbox.in_progress.length;
      // Archive tasks asynchronously (fire-and-forget, best-effort).
      const allTasks = [...inbox.pending, ...inbox.in_progress];
      for (const t of allTasks) {
        inboxStore.archiveTask(uid, t).catch(() => {});
      }
      // Sync write empty inbox to disk.
      const empty = { pending: [], in_progress: [] };
      try { fs.mkdirSync(path.dirname(inboxPath), { recursive: true }); } catch {}
      fs.writeFileSync(inboxPath, JSON.stringify(empty), 'utf-8');
      console.log('[agent-bus] deregistered', uid.slice(-8), '— cleaned', total, 'tasks');
    }
  } catch (e) {
    console.warn('[agent-bus] forceDeregisterAgent: task cleanup error:', e.message);
  }

  store.deleteAgent(uid);
  return { ok: true, existed: true };
}

function getAgent(uid) {
  return store.getAgent(uid);
}

function listAgentsInWorkspace(workspace, opts = {}) {
  const all = store.listAgentsInWorkspace(workspace, { project: opts.project });

  if (opts.includeStale) return all;
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
  if (requester.role !== 'supervisor' && !store.isPMOf(requester, project)) {
    return { ok: false, error: 'only supervisor or project PM can assign agents to a project' };
  }
  await store.setAgentProject(uid, project);
  return { ok: true, uid, project };
}

// Sprint 13: Root Agent — permanent human↔agent communication bridge.
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

module.exports = {
  registerAgent, deregisterAgent, forceDeregisterAgent,
  getAgent, listAgentsInWorkspace, listAllAgentsInWorkspace, touchAgent,
  setProjectPM, assignToProject,
  registerRootAgent, ROOT_UID,
};

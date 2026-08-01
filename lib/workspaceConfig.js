// Workspace-level configuration — PM/PMO assignment + auto-supervisor toggle.
//
// Stores per-workspace settings in $DATA_DIR/workspace-config.json:
//   { "<workspace>": { pm_uid, pmo_uid, auto_supervisor_enabled } }
//
// Constraints (enforced here, not at agent-bus layer):
//   - Max 1 PM per workspace
//   - Max 1 PMO per workspace
//   - PM cannot also be PMO in the same workspace
//
// PMO is NOT auto-registered like HR Agent. Users manually launch PMO and
// assign it to a workspace via this config. PMO is a permission level in
// folder agentLevels (like PM/SE) and an agent-bus role.

'use strict';

const path = require('node:path');
const { DATA_DIR } = require('./config');
const { atomicWriteJson, withFileLock } = require('./atomicJson');
const store = require('./agentBus/store');

const FILE = path.join(DATA_DIR, 'workspace-config.json');

// ── defaults ──────────────────────────────────────────────────────────────

function _defaults() {
  return { pm_uid: null, pmo_uid: null, auto_supervisor_enabled: true };
}

// ── persistence ───────────────────────────────────────────────────────────

async function _load() {
  try {
    const { readFile } = require('node:fs/promises');
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function _save(data) {
  await atomicWriteJson(FILE, data);
}

// ── CRUD ──────────────────────────────────────────────────────────────────

async function get(workspace) {
  const data = await _load();
  return { ..._defaults(), ...(data[workspace] || {}) };
}

async function getAll() {
  const data = await _load();
  const result = {};
  for (const [ws, cfg] of Object.entries(data)) {
    result[ws] = { ..._defaults(), ...cfg };
  }
  return result;
}

// ── PM assignment ─────────────────────────────────────────────────────────

async function setPM(workspace, pmUid) {
  return withFileLock(FILE, async () => {
    const data = await _load();
    const cfg = { ..._defaults(), ...(data[workspace] || {}) };

    // Validate agent exists and is supervisor.
    const agent = store.getAgent(pmUid);
    if (!agent) return { ok: false, error: `agent ${pmUid} not found` };
    if (agent.role !== 'supervisor') {
      return { ok: false, error: 'PM must have supervisor role. Use set_pm to grant supervisor privileges.' };
    }
    if (agent.workspace !== workspace) {
      return { ok: false, error: `agent workspace "${agent.workspace}" does not match "${workspace}"` };
    }

    // Can't be both PM and PMO.
    if (cfg.pmo_uid === pmUid) {
      return { ok: false, error: 'agent is already PMO in this workspace — cannot also be PM' };
    }

    cfg.pm_uid = pmUid;
    data[workspace] = cfg;
    await _save(data);
    return { ok: true, workspace, pm_uid: pmUid };
  });
}

async function clearPM(workspace) {
  return withFileLock(FILE, async () => {
    const data = await _load();
    if (!data[workspace]) return { ok: true, workspace, was_set: false };
    data[workspace].pm_uid = null;
    await _save(data);
    return { ok: true, workspace, was_set: true };
  });
}

// ── PMO assignment ────────────────────────────────────────────────────────

async function setPMO(workspace, pmoUid) {
  return withFileLock(FILE, async () => {
    const data = await _load();
    const cfg = { ..._defaults(), ...(data[workspace] || {}) };

    // Validate agent exists.
    const agent = store.getAgent(pmoUid);
    if (!agent) return { ok: false, error: `agent ${pmoUid} not found` };

    // Validate agent is in the same workspace.
    if (agent.workspace !== workspace) {
      return { ok: false, error: `agent workspace "${agent.workspace}" does not match "${workspace}"` };
    }

    // Can't be both PM and PMO.
    if (cfg.pm_uid === pmoUid) {
      return { ok: false, error: 'agent is already PM in this workspace — cannot also be PMO' };
    }

    // PMO can be supervisor or worker — either is valid.
    // If worker, they get elevated permissions within the workspace.

    cfg.pmo_uid = pmoUid;
    data[workspace] = cfg;
    await _save(data);
    return { ok: true, workspace, pmo_uid: pmoUid };
  });
}

async function clearPMO(workspace) {
  return withFileLock(FILE, async () => {
    const data = await _load();
    if (!data[workspace]) return { ok: true, workspace, was_set: false };
    data[workspace].pmo_uid = null;
    await _save(data);
    return { ok: true, workspace, was_set: true };
  });
}

// ── auto-supervisor toggle ────────────────────────────────────────────────

async function setAutoSupervisor(workspace, enabled) {
  return withFileLock(FILE, async () => {
    const data = await _load();
    const cfg = { ..._defaults(), ...(data[workspace] || {}) };
    cfg.auto_supervisor_enabled = !!enabled;
    data[workspace] = cfg;
    await _save(data);
    return { ok: true, workspace, auto_supervisor_enabled: cfg.auto_supervisor_enabled };
  });
}

async function isAutoSupervisorEnabled(workspace) {
  const cfg = await get(workspace);
  return cfg.auto_supervisor_enabled !== false; // default true
}

// ── validation helpers ────────────────────────────────────────────────────

function getPM(workspace) {
  return get(workspace).then((cfg) => cfg.pm_uid);
}

function getPMO(workspace) {
  return get(workspace).then((cfg) => cfg.pmo_uid);
}

async function isPM(workspace, uid) {
  const cfg = await get(workspace);
  return cfg.pm_uid === uid;
}

async function isPMO(workspace, uid) {
  const cfg = await get(workspace);
  return cfg.pmo_uid === uid;
}

// ── Sprint 33: Unified session permissions query ────────────────────────────
//
// All platform auth goes through session ID. This function is the single entry
// point for querying an agent's permissions by their BOOS session ID.
//
// Returns: { agent, folder, sandbox, workspace } or { error } if not registered.

async function getSessionPermissions(sessionId) {
  // Validate: sessionId must be a BOOS session ID.
  if (!sessionId || !sessionId.startsWith('sess-')) {
    return { error: 'sessionId must be a valid BOOS session ID (sess-xxx)' };
  }

  // 1. Agent lookup by session ID (uid === sessionId in Sprint 33).
  const agent = store.getAgent(sessionId);
  if (!agent) {
    return { error: 'session not registered in agent-bus', hint: 'call register_agent first' };
  }

  // 2. Folder lookup via sandbox (lazy-require to avoid circular deps).
  let folderId = null;
  let folderCfg = null;
  try {
    // Use persistedSessions directly — session ID is the BOOS session ID.
    const persistedSessions = require('./persistedSessions');
    const session = await persistedSessions.findById(sessionId);
    if (session?.folderId) {
      folderId = session.folderId;
      const folders = require('./folders');
      const rootPath = folders.getRootPath(folderId);
      const levels = await folders.getAgentLevels(folderId);
      folderCfg = {
        id: folderId,
        name: folders.getName?.(folderId) || folderId,
        rootPath: rootPath || null,
        agentLevels: levels || {},
        codeWriteEnabled: levels?.[sessionId]?.write !== false,
      };
    }
  } catch { /* folder resolution best-effort */ }

  // 3. Workspace config.
  const wsCfg = await get(agent.workspace || 'boos');

  // 4. Assemble unified permissions.
  const result = {
    sessionId,
    agent: {
      name: agent.name,
      role: agent.role,
      workspace: agent.workspace,
      capabilities: agent.capabilities || [],
      project: agent.project || null,
    },
    folder: folderCfg,
    sandbox: folderCfg ? {
      allowedDirectories: folderCfg.rootPath ? [folderCfg.rootPath] : [],
      writeExtensions: folderCfg.codeWriteEnabled
        ? [] // all extensions allowed
        : ['.md', '.txt', '.json', '.yaml', '.yml', '.toml'],
    } : {
      allowedDirectories: [],
      writeExtensions: ['.md', '.txt', '.json', '.yaml', '.yml', '.toml'],
    },
    workspace: {
      pm_uid: wsCfg.pm_uid,
      pmo_uid: wsCfg.pmo_uid,
      auto_supervisor_enabled: wsCfg.auto_supervisor_enabled,
    },
    isPM: wsCfg.pm_uid === sessionId,
    isPMO: wsCfg.pmo_uid === sessionId,
  };

  return result;
}

module.exports = {
  get, getAll,
  setPM, clearPM, setPMO, clearPMO,
  setAutoSupervisor, isAutoSupervisorEnabled,
  getPM, getPMO, isPM, isPMO,
  getSessionPermissions,
};

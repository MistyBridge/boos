// JSON-file persistence layer for agent-bus (embedded in BOOS).
//
// Single data file: ~/.boos/agent-bus.json
// All writes serialize through withFileLock — no lost updates.
// Reads are lock-free: atomicWriteJson guarantees complete files.
//
// Split across 4 modules (Sprint 31 — ≤500 lines each):
//   storeCore.js     — _load / _syncLoad / DB_PATH (shared, no circular deps)
//   store.js         — core DB + agents + sessions (this file)
//   storeTasks.js    — task CRUD + queries + archival
//   storeIdentity.js — identity cards + session binding + bootstrap

'use strict';

const { _load, _syncLoad, _save, DB_PATH, DATA_DIR, withFileLock } = require('./storeCore');

function getDb() { return { type: 'json-file', path: DB_PATH }; }
function closeDb() { /* no-op — JSON store has no persistent connection */ }

// ── agent helpers ─────────────────────────────────────────────────────

function findAgentByNameWs(name, workspace) {
  const db = _syncLoad();
  const key = `${name}|${workspace}`;
  const uid = db.name_ws_index[key];
  return uid ? (db.agents[uid] || null) : null;
}

function getAgent(uid) {
  return _syncLoad().agents[uid] || null;
}

async function insertAgent({ uid, name, intro, workspace, role, capabilities, project, pm_of }) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const now = new Date().toISOString();
    const isRoot = role === 'root';
    const agent = {
      uid, name: name.slice(0, 64), intro: (intro || '').slice(0, 256),
      workspace: isRoot ? '*' : workspace, role: role || 'worker',
      capabilities: isRoot ? ['root', 'human_interface'] : (Array.isArray(capabilities) ? capabilities.slice(0, 10) : []),
      project: isRoot ? null : (project || null),
      pm_of: isRoot ? [] : (Array.isArray(pm_of) ? pm_of.slice(0, 20) : []),
      registered_at: now,
      last_seen_at: isRoot ? '9999-12-31T23:59:59.999Z' : now,
    };
    db.agents[uid] = agent;
    if (!isRoot) db.name_ws_index[`${name}|${workspace}`] = uid;
    await _save(db);
    return agent;
  });
}

async function touchAgent(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    if (db.agents[uid]) { db.agents[uid].last_seen_at = new Date().toISOString(); await _save(db); }
  });
}

async function deleteAgent(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    const key = `${agent.name}|${agent.workspace}`;
    delete db.name_ws_index[key];
    for (const [sid, s] of Object.entries(db.sessions)) {
      if (s.agent_uid === uid) delete db.sessions[sid];
    }
    delete db.agents[uid];
    await _save(db);
    return true;
  });
}

async function migrateAgentUid(oldUid, newUid) {
  if (oldUid === newUid) return { ok: true, migrated: false };
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[oldUid];
    if (!agent) return { ok: false, error: 'old uid not found' };
    if (db.agents[newUid]) return { ok: false, error: 'new uid already exists' };
    db.agents[newUid] = { ...agent, uid: newUid };
    delete db.agents[oldUid];
    db.name_ws_index[`${agent.name}|${agent.workspace}`] = newUid;
    for (const [tid, t] of Object.entries(db.tasks || {})) {
      if (t.sender_uid === oldUid) t.sender_uid = newUid;
      if (t.receiver_uid === oldUid) t.receiver_uid = newUid;
    }
    for (const [sid, s] of Object.entries(db.sessions || {})) {
      if (s.agent_uid === oldUid) s.agent_uid = newUid;
    }
    await _save(db);
    return { ok: true, migrated: true, oldUid, newUid };
  });
}

function listAgentsInWorkspace(workspace, opts = {}) {
  const db = _syncLoad();
  let agents = Object.values(db.agents).filter((a) => a.workspace === workspace);
  if (opts.project) agents = agents.filter((a) => !a.project || a.project === opts.project);
  return agents
    .map(({ uid, name, intro, workspace, role, capabilities, project, pm_of, last_seen_at }) =>
      ({ uid, name, intro, workspace, role: role || 'worker', capabilities: capabilities || [], project: project || null, pm_of: pm_of || [], last_seen_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listAllAgentsInWorkspace(workspace) {
  const db = _syncLoad();
  return Object.values(db.agents)
    .filter((a) => a.workspace === workspace)
    .map((a) => {
      const sessionCount = Object.values(db.sessions).filter((s) => s.agent_uid === a.uid).length;
      return { uid: a.uid, name: a.name, intro: a.intro, workspace: a.workspace, role: a.role || 'worker', capabilities: a.capabilities || [], project: a.project || null, pm_of: a.pm_of || [], registered_at: a.registered_at, last_seen_at: a.last_seen_at, session_count: sessionCount };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countStaleAgents(cutoff) {
  return Object.values(_syncLoad().agents).filter((a) => a.last_seen_at < cutoff).length;
}

function listAllAgents() {
  return Object.values(_syncLoad().agents).map((a) => ({
    uid: a.uid, name: a.name, intro: a.intro, workspace: a.workspace,
    role: a.role || 'worker', capabilities: a.capabilities || [],
    project: a.project || null, pm_of: a.pm_of || [],
    registered_at: a.registered_at, last_seen_at: a.last_seen_at,
    unresponsive: a.unresponsive || false,
  }));
}

function genTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── session helpers ───────────────────────────────────────────────────

async function bindSession(sessionId, agentUid, workspace) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    db.sessions[sessionId] = { agent_uid: agentUid, workspace, created_at: new Date().toISOString() };
    await _save(db);
  });
}

async function unbindSession(sessionId) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    delete db.sessions[sessionId];
    await _save(db);
  });
}

function getSessionAgentUid(sessionId) {
  const s = _syncLoad().sessions[sessionId];
  return s ? s.agent_uid : null;
}

function getSessionByAgentUid(agentUid) {
  const db = _syncLoad();
  for (const [sid, s] of Object.entries(db.sessions || {})) {
    if (s.agent_uid === agentUid) return sid;
  }
  return null;
}

function countAgentSessions(agentUid) {
  return Object.values(_syncLoad().sessions).filter((s) => s.agent_uid === agentUid).length;
}

// ── PM identity ────────────────────────────────────────────────────────

async function setAgentProject(uid, project) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    agent.project = project || null;
    agent.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

async function setAgentPM(uid, pmOfProjects) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    agent.pm_of = Array.isArray(pmOfProjects) ? pmOfProjects.slice(0, 20) : [];
    agent.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

function isPMOf(agent, project) {
  if (!agent) return false;
  if (agent.role === 'supervisor') return true;
  if (!project || !agent.pm_of) return false;
  return agent.pm_of.includes(project);
}

// ── heartbeat ──────────────────────────────────────────────────────────

async function touchAgentHeartbeat(uid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.last_seen_at = new Date().toISOString();
    if (agent.unresponsive) agent.unresponsive = false;
    await _save(db);
  });
}

async function setAgentUnresponsive(uid, unresponsive) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.unresponsive = unresponsive;
    agent.last_unresponsive_at = unresponsive ? new Date().toISOString() : agent.last_unresponsive_at;
    await _save(db);
  });
}

// ── Sub-modules ────────────────────────────────────────────────────────

const inboxStore = require('./inboxStore');
const storeIdentity = require('./storeIdentity');

// Per-agent inbox task operations (Sprint 35 — decoupled from shared JSON file).
// These delegate directly to inboxStore which reads/writes only the target
// agent's tiny inbox file (~few KB) instead of the monolithic agent-bus.json.
// Fall back to legacy storeTasks for backward compat (tasks created via old API).
const _taskOps = {
  getTask(taskId) {
    // Search index for the task's owner, then read their inbox.
    const queue = require('./queue');
    const ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
    if (ownerUid) {
      const t = inboxStore.getTaskSync(ownerUid, taskId);
      if (t) return t;
    }
    // Fallback: legacy shared store (agent-bus.json).
    return storeTasks.getTask(taskId);
  },
  async getTaskAsync(taskId) {
    const queue = require('./queue');
    const ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
    if (ownerUid) {
      const t = await inboxStore.getTask(ownerUid, taskId);
      if (t) return t;
    }
    return storeTasks.getTaskAsync(taskId);
  },
  listActiveTasks(uid) {
    // Inbox takes priority; fall back to legacy store.
    let tasks = [];
    try {
      const inbox = inboxStore.loadInboxSync(uid);
      tasks = [...inbox.pending, ...inbox.in_progress];
    } catch {}
    if (tasks.length === 0) {
      tasks = storeTasks.listActiveTasks(uid);
    }
    return tasks;
  },
  async countPendingTasks(uid) {
    const n = await inboxStore.countPending(uid);
    if (n > 0) return n;
    return storeTasks.countPendingTasks(uid);
  },
  async listMyTasks(uid) {
    const tasks = await inboxStore.listAllTasks(uid);
    if (tasks.length > 0) return tasks;
    return storeTasks.listMyTasks(uid);
  },
};

// Legacy storeTasks kept for DAG task operations (dag_tasks still in shared store).
const storeTasks = require('./storeTasks');

module.exports = {
  // DB lifecycle
  getDb, closeDb, DB_PATH, DATA_DIR,
  // Agents
  findAgentByNameWs, getAgent, insertAgent, touchAgent, deleteAgent, migrateAgentUid,
  listAgentsInWorkspace, listAllAgentsInWorkspace, listAllAgents, countStaleAgents,
  // Tasks — per-agent inbox (Sprint 35)
  genTaskId,
  getTask: _taskOps.getTask,
  getTaskAsync: _taskOps.getTaskAsync,
  listActiveTasks: _taskOps.listActiveTasks,
  countPendingTasks: _taskOps.countPendingTasks,
  listMyTasks: _taskOps.listMyTasks,
  // Legacy task ops (only for DAG tasks, migration, and backward compat)
  insertTask: storeTasks.insertTask,
  getPendingTask: storeTasks.getPendingTask,
  listPendingTasks: storeTasks.listPendingTasks,
  listAllPendingQueues: storeTasks.listAllPendingQueues,
  getPendingTaskAsync: storeTasks.getPendingTaskAsync,
  listPendingTasksAsync: storeTasks.listPendingTasksAsync,
  claimPendingTaskAsync: storeTasks.claimPendingTaskAsync,
  updateTaskStatus: storeTasks.updateTaskStatus,
  cancelTaskAtomic: storeTasks.cancelTaskAtomic,
  interruptTaskAtomic: storeTasks.interruptTaskAtomic,
  setTaskWorkflowMeta: storeTasks.setTaskWorkflowMeta,
  incrementTaskRetryCount: storeTasks.incrementTaskRetryCount,
  findTask: storeTasks.findTask,
  listAllTasksInWorkspace: storeTasks.listAllTasksInWorkspace,
  pruneOldTasks: storeTasks.pruneOldTasks,
  // Sessions
  bindSession, unbindSession, getSessionAgentUid, getSessionByAgentUid, countAgentSessions,
  // Identity (from storeIdentity)
  ROOT_UID: storeIdentity.ROOT_UID,
  isRootAgent: storeIdentity.isRootAgent,
  writeIdentity: storeIdentity.writeIdentity,
  rebuildAllIndices: storeIdentity.rebuildAllIndices,
  upsertIdentity: storeIdentity.upsertIdentity,
  linkIdentityToSession: storeIdentity.linkIdentityToSession,
  onSessionExited: storeIdentity.onSessionExited,
  bindMcpSession: storeIdentity.bindMcpSession,
  unbindMcpSession: storeIdentity.unbindMcpSession,
  getIdentity: storeIdentity.getIdentity,
  getAgentUidByMcpSession: storeIdentity.getAgentUidByMcpSession,
  autoResolveIdentity: storeIdentity.autoResolveIdentity,
  bootstrapIdentities: storeIdentity.bootstrapIdentities,
  getIdentityByBoosSession: storeIdentity.getIdentityByBoosSession,
  resolveSessionForAgent: storeIdentity.resolveSessionForAgent,
  // PM identity
  setAgentProject, setAgentPM, isPMOf,
  touchAgentHeartbeat, setAgentUnresponsive,
  // Internal (for dagStore.js withFileLock pattern: await store._load())
  _load, _syncLoad,
  // Inbox store (for migration + direct access)
  inboxStore,
};

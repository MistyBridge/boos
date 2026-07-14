// JSON-file persistence layer for agent-bus (embedded in BOOS).
//
// Replaces the external agent-bus's SQLite store with BOOS's existing
// atomicJson utilities. Same API surface, zero new dependencies.
//
// Single data file: ~/.boos/agent-bus.json
// Schema:
//   {
//     agents:       { "<uid>": { uid, name, intro, workspace, role, capabilities,
//                                registered_at, last_seen_at } },
//     tasks:        { "<task_id>": { task_id, sender_uid, sender_name, sender_intro,
//                                    receiver_uid, content, priority, status, result,
//                                    created_at, updated_at } },
//     name_ws_index: { "<name>|<workspace>": "<uid>" },
//     sessions:     { "<session_id>": { agent_uid, workspace, created_at } }
//   }
//
// Design:
//   - All writes serialize through withFileLock(path, fn) — no lost updates.
//   - Reads are lock-free: atomicWriteJson guarantees a complete file on every
//     write (tmp + fsync + rename), so readers always see a consistent snapshot.
//   - The file is loaded fresh on every read operation (no in-memory cache).
//     At the expected scale (dozens of agents, hundreds of tasks) the latency
//     is sub-millisecond.

'use strict';

const path = require('path');
const fs = require('node:fs/promises');
const { atomicWriteJson, withFileLock } = require('../atomicJson');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'agent-bus.json');

// ── internal: load / save ──────────────────────────────────────────────

const EMPTY_DB = { agents: {}, tasks: {}, name_ws_index: {}, sessions: {} };

async function _load() {
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const db = JSON.parse(raw);
    return {
      agents: db.agents || {},
      tasks: db.tasks || {},
      name_ws_index: db.name_ws_index || {},
      sessions: db.sessions || {},
    };
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw e;
  }
}

async function _save(db) {
  await atomicWriteJson(FILE, db);
}

function _syncLoad() {
  try {
    return JSON.parse(require('fs').readFileSync(FILE, 'utf-8'));
  } catch {
    return structuredClone(EMPTY_DB);
  }
}

// ── DB lifecycle ──────────────────────────────────────────────────────

function getDb() {
  // Stub — kept for API compat. JSON store doesn't need a connection handle.
  return { type: 'json-file', path: FILE };
}

function closeDb() {
  // No-op — JSON store has no persistent connection.
}

const DB_PATH = FILE;

// ── agent helpers ─────────────────────────────────────────────────────

function findAgentByNameWs(name, workspace) {
  const db = _syncLoad();
  const key = `${name}|${workspace}`;
  const uid = db.name_ws_index[key];
  if (!uid) return null;
  return db.agents[uid] || null;
}

function getAgent(uid) {
  const db = _syncLoad();
  return db.agents[uid] || null;
}

async function insertAgent({ uid, name, intro, workspace, role, capabilities }) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const now = new Date().toISOString();
    const agent = {
      uid,
      name: name.slice(0, 64),
      intro: (intro || '').slice(0, 256),
      workspace,
      role: role || 'worker',
      capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 10) : [],
      registered_at: now,
      last_seen_at: now,
    };
    db.agents[uid] = agent;
    db.name_ws_index[`${name}|${workspace}`] = uid;
    await _save(db);
    return agent;
  });
}

async function touchAgent(uid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    if (db.agents[uid]) {
      db.agents[uid].last_seen_at = new Date().toISOString();
      await _save(db);
    }
  });
}

async function deleteAgent(uid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    // Remove from name_ws_index.
    const key = `${agent.name}|${agent.workspace}`;
    delete db.name_ws_index[key];
    // Remove associated sessions.
    for (const [sid, s] of Object.entries(db.sessions)) {
      if (s.agent_uid === uid) delete db.sessions[sid];
    }
    delete db.agents[uid];
    await _save(db);
    return true;
  });
}

function listAgentsInWorkspace(workspace) {
  const db = _syncLoad();
  return Object.values(db.agents)
    .filter((a) => a.workspace === workspace)
    .map(({ uid, name, intro, workspace, role, capabilities, last_seen_at }) => ({
      uid,
      name,
      intro,
      workspace,
      role: role || 'worker',
      capabilities: capabilities || [],
      last_seen_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Supervisor-only: return ALL agents in workspace including stale ones,
// with full metadata (role, capabilities, session count).
function listAllAgentsInWorkspace(workspace) {
  const db = _syncLoad();
  return Object.values(db.agents)
    .filter((a) => a.workspace === workspace)
    .map((a) => {
      const sessionCount = Object.values(db.sessions).filter((s) => s.agent_uid === a.uid).length;
      return {
        uid: a.uid,
        name: a.name,
        intro: a.intro,
        workspace: a.workspace,
        role: a.role || 'worker',
        capabilities: a.capabilities || [],
        registered_at: a.registered_at,
        last_seen_at: a.last_seen_at,
        session_count: sessionCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countStaleAgents(cutoff) {
  const db = _syncLoad();
  return Object.values(db.agents).filter((a) => a.last_seen_at < cutoff).length;
}

// ── task helpers ──────────────────────────────────────────────────────

function genTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function insertTask(task) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    db.tasks[task.task_id] = {
      task_id: task.task_id,
      sender_uid: task.sender_uid,
      sender_name: (task.sender_name || '').slice(0, 64),
      sender_intro: (task.sender_intro || '').slice(0, 256),
      receiver_uid: task.receiver_uid,
      content: task.content,
      priority: task.priority || 'normal',
      status: task.status,
      result: task.result || null,
      workflow_id: task.workflow_id || null,
      stage_id: task.stage_id || null,
      created_at: task.created_at,
      updated_at: task.updated_at || null,
    };
    await _save(db);
    return task;
  });
}

function getTask(taskId) {
  const db = _syncLoad();
  return db.tasks[taskId] || null;
}

function getPendingTask(receiverUid) {
  const db = _syncLoad();
  const pending = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return pending[0] || null;
}

function listPendingTasks(receiverUid) {
  const db = _syncLoad();
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function countPendingTasks(receiverUid) {
  const db = _syncLoad();
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .length;
}

async function updateTaskStatus(taskId, status, result) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return;
    const now = new Date().toISOString();
    task.status = status;
    task.updated_at = now;
    if (result !== undefined && result !== null) {
      task.result = result.slice(0, 8192);
    }
    await _save(db);
  });
}

function listMyTasks(uid) {
  const db = _syncLoad();
  return Object.values(db.tasks)
    .filter((t) => t.sender_uid === uid || t.receiver_uid === uid)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function findTask(taskId) {
  const db = _syncLoad();
  const task = db.tasks[taskId];
  if (!task) return null;
  // Count tasks ahead in same receiver's pending queue.
  const ahead = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === task.receiver_uid && t.status === 'pending' && t.created_at < task.created_at)
    .length;
  return { task, queue_position: ahead };
}

// ── session helpers ───────────────────────────────────────────────────

async function bindSession(sessionId, agentUid, workspace) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    db.sessions[sessionId] = { agent_uid: agentUid, workspace, created_at: new Date().toISOString() };
    await _save(db);
  });
}

async function unbindSession(sessionId) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    delete db.sessions[sessionId];
    await _save(db);
  });
}

function getSessionAgentUid(sessionId) {
  const db = _syncLoad();
  const s = db.sessions[sessionId];
  return s ? s.agent_uid : null;
}

function countAgentSessions(agentUid) {
  const db = _syncLoad();
  return Object.values(db.sessions).filter((s) => s.agent_uid === agentUid).length;
}

module.exports = {
  // DB lifecycle
  getDb, closeDb, DB_PATH, DATA_DIR,
  // Agents
  findAgentByNameWs, getAgent, insertAgent, touchAgent, deleteAgent,
  listAgentsInWorkspace, listAllAgentsInWorkspace, countStaleAgents,
  // Tasks
  genTaskId, insertTask, getTask, getPendingTask, listPendingTasks, countPendingTasks,
  updateTaskStatus, listMyTasks, findTask,
  // Sessions
  bindSession, unbindSession, getSessionAgentUid, countAgentSessions,
};

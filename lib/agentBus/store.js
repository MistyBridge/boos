// JSON-file persistence layer for agent-bus (embedded in BOOS).
//
// Replaces the external agent-bus's SQLite store with BOOS's existing
// atomicJson utilities. Same API surface, zero new dependencies.
//
// Single data file: ~/.boos/agent-bus.json
// Schema:
//   {
//     agents:       { "<uid>": { uid, name, intro, workspace, role, capabilities,
//                                project, pm_of, registered_at, last_seen_at } },
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

const EMPTY_DB = { agents: {}, tasks: {}, name_ws_index: {}, sessions: {}, identities: {}, identity_by_boos_session: {}, identity_by_mcp_session: {}, identity_by_name_ws: {} };

async function _load() {
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const db = JSON.parse(raw);
    return {
      agents: db.agents || {},
      tasks: db.tasks || {},
      name_ws_index: db.name_ws_index || {},
      sessions: db.sessions || {},
      identities: db.identities || {},
      identity_by_boos_session: db.identity_by_boos_session || {},
      identity_by_mcp_session: db.identity_by_mcp_session || {},
      identity_by_name_ws: db.identity_by_name_ws || {},
    };
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw e;
  }
}

async function _save(db) {
  await atomicWriteJson(FILE, db);
}

/**
 * ⚠️ DEPRECATED — reads WITHOUT withFileLock. Use async _load() instead.
 *
 * Risks:
 *   1. TOCTOU race: a concurrent insertTask/updateTaskStatus committed
 *      between _syncLoad and _save will be silently overwritten.
 *   2. Truncated reads: if another writer is mid-atomicWriteJson (tmp +
 *      fsync + rename), readFileSync may see a partial file on some
 *      filesystems (though atomicWriteJson mitigates this via rename).
 *   3. Stale snapshot: any caller that reads with _syncLoad, mutates, then
 *      calls _save WITHOUT withFileLock can clobber concurrent writes.
 *
 * All mutating callers MUST use withFileLock + _load(). Read-only callers
 * that can tolerate stale data (e.g. listAgentsInWorkspace for display)
 * may continue to use this. All new code MUST use async variants.
 *
 * @deprecated since Sprint 9 — retained for read-only backward compat.
 * @returns {{ agents, tasks, name_ws_index, sessions, identities,
 *            identity_by_boos_session, identity_by_name_ws }}
 */
function _syncLoad() {
  try {
    const db = JSON.parse(require('fs').readFileSync(FILE, 'utf-8'));
    // Sprint 13: ensure new schema fields have defaults for backward compat.
    db.identities = db.identities || {};
    db.identity_by_boos_session = db.identity_by_boos_session || {};
    db.identity_by_mcp_session = db.identity_by_mcp_session || {};
    db.identity_by_name_ws = db.identity_by_name_ws || {};
    return db;
  } catch (e) {
    // Sprint 13.3: log corruption warnings instead of silently swallowing.
    if (e.code !== 'ENOENT') {
      console.warn('[agent-bus] _syncLoad: failed to parse agent-bus.json — returning empty DB. Error:', e.message);
    }
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
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const key = `${name}|${workspace}`;
  const uid = db.name_ws_index[key];
  if (!uid) return null;
  return db.agents[uid] || null;
}

function getAgent(uid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return db.agents[uid] || null;
}

async function insertAgent({ uid, name, intro, workspace, role, capabilities, project, pm_of }) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const now = new Date().toISOString();
    const isRoot = role === 'root';
    const agent = {
      uid,
      name: name.slice(0, 64),
      intro: (intro || '').slice(0, 256),
      workspace: isRoot ? '*' : workspace,
      role: role || 'worker',
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

function listAgentsInWorkspace(workspace, opts = {}) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  let agents = Object.values(db.agents).filter((a) => a.workspace === workspace);

  // Project-scope filter: show agents in same project, or agents with no project (legacy).
  if (opts.project) {
    agents = agents.filter((a) => !a.project || a.project === opts.project);
  }

  return agents
    .map(({ uid, name, intro, workspace, role, capabilities, project, pm_of, last_seen_at }) => ({
      uid,
      name,
      intro,
      workspace,
      role: role || 'worker',
      capabilities: capabilities || [],
      project: project || null,
      pm_of: pm_of || [],
      last_seen_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Supervisor-only: return ALL agents in workspace including stale ones,
// with full metadata (role, capabilities, session count).
function listAllAgentsInWorkspace(workspace) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
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
        project: a.project || null,
        pm_of: a.pm_of || [],
        registered_at: a.registered_at,
        last_seen_at: a.last_seen_at,
        session_count: sessionCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countStaleAgents(cutoff) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
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
      reply_to: task.reply_to || null,
      required_capabilities: task.required_capabilities || [],
      matched_via: task.matched_via || 'direct',
      metadata: task.metadata || null,
      retry_count: task.retry_count || 0,
      created_at: task.created_at,
      updated_at: task.updated_at || null,
    };
    await _save(db);
    return task;
  });
}

function getTask(taskId) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return db.tasks[taskId] || null;
}

async function getTaskAsync(taskId) {
  const db = await _load();
  return db.tasks[taskId] || null;
}

// ⚠️ DEPRECATED (Sprint 9): use getPendingTaskAsync() instead.
// This sync version reads without withFileLock and can miss tasks
// that were inserted concurrently. Kept for backward compat only.
function getPendingTask(receiverUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const PRIO = { high: 0, normal: 1, low: 2 };
  const pending = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1;
      const pb = PRIO[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;            // high before normal before low
      return a.created_at.localeCompare(b.created_at); // FIFO within same priority
    });
  return pending[0] || null;
}

function listPendingTasks(receiverUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1;
      const pb = PRIO[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });
}

// M1: List all receiver_uids that have pending tasks (non-empty queues)
// Used by notifications.js to scan for agents that need wake-up signals.
function listAllPendingQueues() {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const queueUids = new Set();
  for (const task of Object.values(db.tasks)) {
    if (task.status === 'pending' && task.receiver_uid) {
      queueUids.add(task.receiver_uid);
    }
  }
  return Array.from(queueUids);
}

// Sprint 13.4: list all active (pending + in_progress) tasks for an agent.
// Used by wakeAgent to deliver tasks even if they were auto-delivered but
// the agent hasn't responded yet.
function listActiveTasks(receiverUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && (t.status === 'pending' || t.status === 'in_progress'))
    .sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1;
      const pb = PRIO[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });
}

// ── Async versions (Sprint 8 #84 fix) ─────────────────────────────────
// Uses _load() (async) instead of _syncLoad() so callers that just
// awaited insertTask/updateTaskStatus see fresh data.

async function getPendingTaskAsync(receiverUid) {
  const db = await _load();
  const PRIO = { high: 0, normal: 1, low: 2 };
  const pending = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1;
      const pb = PRIO[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });
  return pending[0] || null;
}

async function listPendingTasksAsync(receiverUid) {
  const db = await _load();
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1;
      const pb = PRIO[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });
}

// Atomically claim the oldest pending task for a receiver.
// Reads + marks in_progress under a single withFileLock — no TOCTOU race.
// Fixes Sprint 6 P0: checkInbox getPendingTaskAsync → updateTaskStatus gap.
async function claimPendingTaskAsync(receiverUid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const PRIO = { high: 0, normal: 1, low: 2 };
    const pending = Object.values(db.tasks)
      .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
      .sort((a, b) => {
        const pa = PRIO[a.priority] ?? 1;
        const pb = PRIO[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return a.created_at.localeCompare(b.created_at);
      });
    const task = pending[0];
    if (!task) return null;
    const now = new Date().toISOString();
    task.status = 'in_progress';
    task.updated_at = now;
    await _save(db);
    return task;
  });
}

function countPendingTasks(receiverUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .length;
}

// Atomically update task status. Uses withFileLock — no TOCTOU race.
// metadata (optional): structured metadata for typed workflows (Sprint 18).
async function updateTaskStatus(taskId, status, result, metadata) {
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
    if (metadata !== undefined && metadata !== null) {
      task.metadata = metadata;
    }
    await _save(db);
  });
}

// Sprint 16: Atomically cancel a task — read + validate + write under lock.
// Fixes TOCTOU race in queue.cancelTask / supervisorCancelTask where
// getTask (sync, no lock) and updateTaskStatus (async, locked) run in
// separate ops, allowing status changes between the read and write.
// CANCELLABLE = { pending, blocked }.
async function cancelTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const CANCELLABLE = new Set(['pending', 'blocked']);
  return withFileLock(FILE, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return { ok: false, error: 'task not found' };
    if (!supervisor && task.sender_uid !== requesterUid) {
      return { ok: false, error: 'only the sender can cancel a task' };
    }
    if (!CANCELLABLE.has(task.status)) {
      return { ok: false, error: 'cannot cancel task in status "' + task.status + '" — only pending/blocked tasks can be cancelled' };
    }
    task.status = 'cancelled';
    task.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true };
  });
}

// Sprint 16: Atomically interrupt a task — read + validate + write under lock.
// INTERRUPTIBLE = { in_progress }.
async function interruptTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  return withFileLock(FILE, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return { ok: false, error: 'task not found' };
    if (!supervisor && task.sender_uid !== requesterUid) {
      return { ok: false, error: 'only the sender can interrupt a task' };
    }
    if (task.status !== 'in_progress') {
      return { ok: false, error: 'cannot interrupt task in status "' + task.status + '" — only in-progress tasks can be interrupted' };
    }
    task.status = 'interrupted';
    task.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true };
  });
}

// Atomically attach workflow metadata to an existing task.
// Uses withFileLock → no TOCTOU race between read and write.
async function setTaskWorkflowMeta(taskId, workflowId, stageId) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return false;
    task.workflow_id = workflowId;
    task.stage_id = stageId;
    task.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

// Atomically bump retry_count and reset to pending.
// Uses withFileLock — no TOCTOU race (fixes #83).
async function incrementTaskRetryCount(taskId) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return { ok: false, count: 0 };
    const count = (task.retry_count || 0) + 1;
    task.retry_count = count;
    task.status = 'pending';
    task.result = null;
    task.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true, count };
  });
}

function listMyTasks(uid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.tasks)
    .filter((t) => t.sender_uid === uid || t.receiver_uid === uid)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Sprint 17: return ALL tasks in a workspace (supervisor view).
// Replaces the direct readFileSync(DB_PATH) pattern in handlers.js
// _listMyTasks supervisor path. Read-only via _syncLoad — safe.
function listAllTasksInWorkspace(workspace) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.tasks || {})
    .filter((t) => {
      const sender = db.agents[t.sender_uid];
      const receiver = db.agents[t.receiver_uid];
      return (sender && sender.workspace === workspace) ||
             (receiver && receiver.workspace === workspace);
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function findTask(taskId) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const task = db.tasks[taskId];
  if (!task) return null;
  // Count tasks ahead in same receiver's pending queue.
  const ahead = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === task.receiver_uid && t.status === 'pending' && t.created_at < task.created_at)
    .length;
  return { task, queue_position: ahead };
}

async function bindMcpSession(mcpSessionId, agentUid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    db.identity_by_mcp_session[mcpSessionId] = agentUid;
    await _save(db);
  });
}

async function unbindMcpSession(mcpSessionId) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    delete db.identity_by_mcp_session[mcpSessionId];
    await _save(db);
  });
}

function getAgentUidByMcpSession(mcpSessionId) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return db.identity_by_mcp_session[mcpSessionId] || null;
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
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const s = db.sessions[sessionId];
  return s ? s.agent_uid : null;
}

// Reverse lookup: find session id by agent UID.
// Used by notifications.js to route outbound messages to the correct PTY.
function getSessionByAgentUid(agentUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  for (const [sid, s] of Object.entries(db.sessions || {})) {
    if (s.agent_uid === agentUid) return sid;
  }
  return null;
}

function countAgentSessions(agentUid) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.sessions).filter((s) => s.agent_uid === agentUid).length;
}

// ── Identity card system (Sprint 13/16) ───────────────────────────────
// Each agent gets a unified "identity card" that cross-references all IDs:
// agent UID ↔ BOOS session ID ↔ MCP session ID ↔ name+workspace.
// This replaces the heuristic cwd-basename matching in persistedSessions.findByAgentName.
//
// Sprint 16 hard constraint: critical fields (boos_session_id, name, workspace,
// mcp_session_id) MUST NOT be null after registration.  The identity card is
// the single source of truth for session routing; a null boos_session_id means
// agent-to-agent responses can never reach the agent's PTY.

// Sprint 16: ALL fields are mandatory.  A null field means broken routing.
// The identity card is the single source of truth for session resolution;
// any null breaks agent-to-agent communication.
const REQUIRED_IDENTITY_FIELDS = [
  'agent_uid', 'name', 'workspace', 'role',
  'boos_session_id', 'mcp_session_id', 'cwd',
  'pty_pid', 'updated_at',
];

/**
 * Validate an identity card.  ALL fields must be non-null / non-empty.
 * ROOT agent (uid === ROOT_UID) is exempt — it has no PTY session.
 * Returns { ok, missing[] }.
 */
function validateIdentity(identity) {
  if (!identity) return { ok: false, missing: ['(identity is null)'] };
  // ROOT agent: no PTY, special sentinel values are acceptable.
  if (identity.agent_uid === ROOT_UID) return { ok: true, missing: [] };

  const missing = [];
  for (const f of REQUIRED_IDENTITY_FIELDS) {
    const v = identity[f];
    if (v === null || v === undefined || v === '') {
      missing.push(f);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Try to find a BOOS session matching an agent by name+workspace.
 * Returns the session ID string or null.
 */
async function resolveBoosSessionForAgent(name, workspace) {
  try {
    const { loadAll } = require('../persistedSessions');
    const all = await loadAll();
    // Match by title (exact) or workspace-derived name
    const match = all.find((s) =>
      !s.deletedAt &&
      (s.title === name || s.workspace === name),
    );
    return match ? match.id : null;
  } catch {
    return null;
  }
}

async function upsertIdentity(agentUid, fields) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const existing = db.identities[agentUid] || {};

    // Merge: null fields mean "don't overwrite"
    const merged = { ...existing };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) merged[k] = v;
      else if (v === null && !(k in existing)) merged[k] = null;
    }
    merged.agent_uid = agentUid;
    merged.updated_at = new Date().toISOString();
    db.identities[agentUid] = merged;

    // Maintain reverse index: boos_session_id → uid
    if (fields.boos_session_id !== undefined && existing.boos_session_id !== fields.boos_session_id) {
      if (existing.boos_session_id) delete db.identity_by_boos_session[existing.boos_session_id];
      if (fields.boos_session_id) db.identity_by_boos_session[fields.boos_session_id] = agentUid;
    }

    // Maintain reverse index: name|workspace → uid
    const name = fields.name || existing.name;
    const workspace = fields.workspace || existing.workspace;
    if (name && workspace) {
      const nwKey = name + '|' + workspace;
      db.identity_by_name_ws[nwKey] = agentUid;
    }

    await _save(db);
    return merged;
  });
}

function getIdentity(query) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  let uid = null;

  if (query.uid) {
    uid = query.uid;
  } else if (query.boosSessionId) {
    uid = db.identity_by_boos_session[query.boosSessionId];
  } else if (query.name && query.workspace) {
    uid = db.identity_by_name_ws[query.name + '|' + query.workspace];
  } else if (query.name) {
    // Fallback: scan identity_by_name_ws for matching name prefix.
    for (const [key, v] of Object.entries(db.identity_by_name_ws || {})) {
      if (key.startsWith(query.name + '|')) { uid = v; break; }
    }
  }

  if (uid && db.identities[uid]) {
    return { ...db.identities[uid] };
  }
  return null;
}

function getIdentityByBoosSession(sessionId) {
  return getIdentity({ boosSessionId: sessionId });
}

// Sprint 13 ROOT_UID — permanent identity for the human↔agent bridge.
const ROOT_UID = 'agent_root';

function isRootAgent(uid) {
  const agent = _syncLoad().agents[uid]; // @stale-ok: read-only, no lock needed
  return agent && agent.role === 'root';
}

// Sprint 14: bootstrap missing identity cards from agents + sessions data.
// After a server restart the identities table may be empty even though agents
// and sessions are persisted.  Rebuild basic identity cards so sandbox
// folder-level PM/SE permissions work without waiting for re-registration.
async function bootstrapIdentities() {
  return withFileLock(FILE, async () => {
    const db = await _load();
    let rebuilt = 0;

    for (const [uid, agent] of Object.entries(db.agents)) {
      if (!db.identities[uid]) {
        db.identities[uid] = {
          agent_uid: uid,
          name: agent.name,
          workspace: agent.workspace,
          role: agent.role || 'worker',
          updated_at: new Date().toISOString(),
        };
        if (agent.name && agent.workspace) {
          db.identity_by_name_ws[agent.name + '|' + agent.workspace] = uid;
        }
        rebuilt++;
      }
    }

    // Sprint 16: cross-reference — link any identity with missing boos_session_id.
    // Runs when (a) new identities were rebuilt, (b) the reverse index is empty,
    // or (c) any existing identity has boos_session_id === null.
    const hasMissingBoosSession = Object.values(db.identities).some(
      (ident) => ident.name !== 'BOOS Root' && !ident.boos_session_id,
    );
    if (rebuilt > 0 || Object.keys(db.identity_by_boos_session).length === 0 || hasMissingBoosSession) {
      try {
        const { loadAll } = require('../persistedSessions');
        const all = await loadAll();
        for (const [uid, ident] of Object.entries(db.identities)) {
          if (ident.boos_session_id) continue; // already linked
          // Skip root agent (no PTY session)
          if (uid === ROOT_UID) continue;
          const match = all.find((s) =>
            !s.deletedAt &&
            (s.title === ident.name || s.workspace === ident.name.replace(/[<>:"/\\|?*]/g, '_')),
          );
          if (match) {
            db.identities[uid] = { ...ident, boos_session_id: match.id, cwd: match.cwd, updated_at: new Date().toISOString() };
            db.identity_by_boos_session[match.id] = uid;
            rebuilt++;
            console.log('[agent-bus] bootstrap: linked', ident.name, '→', match.id);
          }
        }
      } catch (e) {
        console.warn('[agent-bus] bootstrapIdentities: session cross-ref skipped:', e.message);
      }
    }

    if (rebuilt > 0) {
      await _save(db);
      console.log('[agent-bus] bootstrapIdentities: rebuilt', rebuilt, 'identity card(s)');
    }
    return rebuilt;
  });
}

// ── PM identity system (Sprint 8 Wave 1) ────────────────────────────────

async function setAgentProject(uid, project) {
  return withFileLock(FILE, async () => {
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
  return withFileLock(FILE, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return false;
    agent.pm_of = Array.isArray(pmOfProjects) ? pmOfProjects.slice(0, 20) : [];
    agent.updated_at = new Date().toISOString();
    await _save(db);
    return true;
  });
}

// Check if agent is PM of a specific project (or is workspace supervisor).
function isPMOf(agent, project) {
  if (!agent) return false;
  if (agent.role === 'supervisor') return true; // workspace supervisor = PM of all projects
  if (!project || !agent.pm_of) return false;
  return agent.pm_of.includes(project);
}

// ── Sprint 10: Heartbeat + Liveness ──────────────────────────────────

// Sprint 13.3: made async with withFileLock to prevent TOCTOU races.
// Previously used _syncLoad + writeFileSync which could overwrite
// concurrent inserts/updates from other operations.
async function touchAgentHeartbeat(uid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.last_seen_at = new Date().toISOString();
    if (agent.unresponsive) {
      agent.unresponsive = false;
    }
    await _save(db);
  });
}

// Sprint 13.3: made async with withFileLock (same TOCTOU fix).
async function setAgentUnresponsive(uid, unresponsive) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const agent = db.agents[uid];
    if (!agent) return;
    agent.unresponsive = unresponsive;
    agent.last_unresponsive_at = unresponsive ? new Date().toISOString() : agent.last_unresponsive_at;
    await _save(db);
  });
}

// Sprint 11: return ALL agents regardless of workspace — used by
// routes/agents.js to build the merged agent + session list.
function listAllAgents() {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.agents).map((a) => ({
    uid: a.uid,
    name: a.name,
    intro: a.intro,
    workspace: a.workspace,
    role: a.role || 'worker',
    capabilities: a.capabilities || [],
    project: a.project || null,
    pm_of: a.pm_of || [],
    registered_at: a.registered_at,
    last_seen_at: a.last_seen_at,
    unresponsive: a.unresponsive || false,
  }));
}

// ── Sprint 18: Task archival — prevent store file bloat ──────────────
// 4063 accumulated tasks → 3 MB JSON. Every write parses + stringifies
// the whole file.  Prune completed/cancelled/notification tasks older
// than `maxAgeMs` (default 7 days) to an archive file so the working
// set stays small and writes stay fast.

const ARCHIVE_DIR = path.join(DATA_DIR, 'archive', 'tasks');

async function _ensureArchiveDir() {
  try {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  } catch {}
}

async function pruneOldTasks(maxAgeMs = 7 * 24 * 3600_000) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'notification', 'interrupted', 'exhausted']);

    const toArchive = [];
    for (const [tid, t] of Object.entries(db.tasks || {})) {
      if (TERMINAL.has(t.status) && t.created_at < cutoff) {
        toArchive.push(t);
        delete db.tasks[tid];
      }
    }

    if (toArchive.length === 0) return 0;

    // Write archive file — one JSON object per line (JSONL) for easy streaming.
    await _ensureArchiveDir();
    const archiveFile = path.join(ARCHIVE_DIR,
      `tasks-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = toArchive.map((t) => JSON.stringify(t)).join('\n') + '\n';
    await fs.appendFile(archiveFile, lines, 'utf-8');

    await _save(db);
    console.log('[agent-bus] pruned', toArchive.length, 'old tasks →', archiveFile,
      '(remaining:', Object.keys(db.tasks).length, 'tasks,',
      Math.round(JSON.stringify(db).length / 1024), 'KB)');
    return toArchive.length;
  });
}

module.exports = {
  // DB lifecycle
  getDb, closeDb, DB_PATH, DATA_DIR,
  // Agents
  findAgentByNameWs, getAgent, insertAgent, touchAgent, deleteAgent,
  listAgentsInWorkspace, listAllAgentsInWorkspace, listAllAgents, countStaleAgents,
  // Tasks
  genTaskId, insertTask, getTask, getTaskAsync, getPendingTask, listPendingTasks, listActiveTasks, countPendingTasks, listAllPendingQueues,
  getPendingTaskAsync, listPendingTasksAsync, claimPendingTaskAsync,
  updateTaskStatus, cancelTaskAtomic, interruptTaskAtomic,
  setTaskWorkflowMeta, incrementTaskRetryCount, listMyTasks, findTask, listAllTasksInWorkspace,
  // Sprint 18: task archival
  pruneOldTasks,
  // Sessions
  bindSession, unbindSession, getSessionAgentUid, getSessionByAgentUid, countAgentSessions,
  // Identity cards (Sprint 13)
  upsertIdentity, getIdentity, getIdentityByBoosSession, bootstrapIdentities,
  validateIdentity, resolveBoosSessionForAgent, bindMcpSession, unbindMcpSession, getAgentUidByMcpSession,
  ROOT_UID, isRootAgent,
  // PM identity system (Sprint 8 Wave 1)
  setAgentProject, setAgentPM, isPMOf, touchAgentHeartbeat, setAgentUnresponsive,
  // Internal (used by notifications.js stale-reclaimer)
  _load,
};

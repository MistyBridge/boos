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
    // Sprint 39: also scan all per-agent inbox files (source of truth
    // since Sprint 35) and update sender/receiver UID references.
    try {
      const ib = require('./inboxStore');
      const fs = require('fs');
      const inboxDir = ib.INBOX_DIR;
      const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const uid = f.replace('.json', '');
        const inbox = ib.loadInboxSync(uid);
        let changed = false;
        for (const arr of ['pending', 'in_progress']) {
          for (const t of (inbox[arr] || [])) {
            if (t.sender_uid === oldUid) { t.sender_uid = newUid; changed = true; }
            if (t.receiver_uid === oldUid) { t.receiver_uid = newUid; changed = true; }
          }
        }
        if (changed) {
          try {
            await ib.saveInbox(uid, inbox);
          } catch {}
        }
      }
    } catch (e) { console.warn('[boos] migrateAgentUid inbox scan failed:', e.message); }
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

// Per-agent inbox task operations (Sprint 35-39 — unified to inboxStore).
// All tasks live exclusively in per-agent inbox files. storeTasks.js removed.
const _taskOps = {
  getTask(taskId) {
    // Search index for the task's owner, then read their inbox.
    const queue = require('./queue');
    const ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
    if (ownerUid) {
      const t = inboxStore.getTaskSync(ownerUid, taskId);
      if (t) return t;
    }
    // Fallback: scan all inbox files.
    const found = _findTaskInbox(taskId);
    return found ? found.task : null;
  },
  async getTaskAsync(taskId) {
    const queue = require('./queue');
    const ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
    if (ownerUid) {
      const t = await inboxStore.getTask(ownerUid, taskId);
      if (t) return t;
    }
    const found = await _findTaskInboxAsync(taskId);
    return found ? found.task : null;
  },
  listActiveTasks(uid) {
    // Sprint 39: inbox files are the sole source of truth (Sprint 35 refactor).
    // Removed fallback to storeTasks (agent-bus.json) which caused phantom
    // activeTask counts from stale notification-loop tasks.
    try {
      const inbox = inboxStore.loadInboxSync(uid);
      return [...inbox.pending, ...inbox.in_progress];
    } catch {}
    return [];
  },
  async countPendingTasks(uid) {
    // Sprint 39: inbox-only. Never fall back to agent-bus.json — stale
    // tasks from deregistered agents would inflate the count permanently.
    return await inboxStore.countPending(uid);
  },
  async listMyTasks(uid) {
    // Sprint 39: scan all inboxes for tasks where uid is sender OR receiver.
    // The old storeTasks.listMyTasks scanned agent-bus.json for both roles.
    const all = [];
    try {
      const fs = require('fs');
      const path = require('path');
      const inboxDir = inboxStore.INBOX_DIR;
      const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const inbox = inboxStore.loadInboxSync(f.replace('.json', ''));
          for (const t of [...inbox.pending, ...inbox.in_progress]) {
            if (t.sender_uid === uid || t.receiver_uid === uid) {
              all.push(t);
            }
          }
        } catch {}
      }
    } catch {}
    all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return all;
  },
};

// Sprint 39: Unified task storage — all task ops now delegate to inboxStore
// (per-agent inbox files). storeTasks.js has been removed.

// Helper: find which inbox file owns a task by scanning all inboxes.
function _findTaskInbox(taskId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      const t = inboxStore.getTaskSync(uid, taskId);
      if (t) return { uid, task: t };
    }
  } catch {}
  return null;
}

async function _findTaskInboxAsync(taskId) {
  try {
    const fs = require('fs/promises');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    let files;
    try { files = await fs.readdir(inboxDir); } catch { return null; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      const t = await inboxStore.getTask(uid, taskId);
      if (t) return { uid, task: t };
    }
  } catch {}
  return null;
}

// Synchronous task ops — scan all inboxes sync.
function getPendingTask(uid) {
  try {
    const inbox = inboxStore.loadInboxSync(uid);
    const PRIO = { high: 0, normal: 1, low: 2 };
    // Only return tasks with status 'pending' (exclude in_progress etc.)
    return inbox.pending.filter(t => t.status === 'pending').sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1;
      return pa !== pb ? pa - pb : (a.created_at || '').localeCompare(b.created_at || '');
    })[0] || null;
  } catch { return null; }
}

function listPendingTasks(uid) {
  try {
    return inboxStore.loadInboxSync(uid).pending;
  } catch { return []; }
}

function listAllPendingQueues() {
  // Return array of UID strings (same format as old storeTasks.listAllPendingQueues).
  const queueUids = new Set();
  try {
    const fs = require('fs');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      try {
        const inbox = inboxStore.loadInboxSync(uid);
        if (inbox.pending.some(t => t.status === 'pending')) {
          queueUids.add(uid);
        }
      } catch {}
    }
  } catch {}
  return Array.from(queueUids);
}

// Async task ops.
async function insertTask(task) {
  // Normalise fields (mirrors old storeTasks.insertTask).
  const normalized = {
    ...task,
    sender_name: (task.sender_name || '').slice(0, 64),
    sender_intro: (task.sender_intro || '').slice(0, 256),
    content: (task.content || '').slice(0, 4096),
    result: task.result ? String(task.result).slice(0, 8192) : null,
  };
  // Sprint 39: respect task status — in_progress tasks go to in_progress
  // array, not pending.  Tests insert tasks with explicit statuses for
  // isolation; production send_task always sets status='pending'.
  const TERMINAL = new Set(['completed', 'cancelled', 'exhausted']);
  if (normalized.status === 'in_progress') {
    const inbox = await inboxStore.loadInbox(task.receiver_uid);
    inbox.in_progress.push(normalized);
    await inboxStore.saveInbox(task.receiver_uid, inbox);
  } else if (TERMINAL.has(normalized.status)) {
    await inboxStore.archiveTask(task.receiver_uid, normalized);
  } else {
    await inboxStore.addPending(task.receiver_uid, normalized);
  }
  const queue = require('./queue');
  if (queue._indexTask) queue._indexTask(task.task_id, task.receiver_uid);
  return normalized;
}

async function getPendingTaskAsync(uid) {
  const PRIO = { high: 0, normal: 1, low: 2 };
  const inbox = await inboxStore.loadInbox(uid);
  return inbox.pending.sort((a, b) => {
    const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1;
    return pa !== pb ? pa - pb : (a.created_at || '').localeCompare(b.created_at || '');
  })[0] || null;
}

async function listPendingTasksAsync(uid) {
  return (await inboxStore.loadInbox(uid)).pending;
}

async function claimPendingTaskAsync(uid) {
  return inboxStore.claimPending(uid);
}

async function updateTaskStatus(taskId, status, result, metadata) {
  const queue = require('./queue');
  let ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
  let task = null;
  if (!ownerUid) {
    const found = await _findTaskInboxAsync(taskId);
    if (!found) return null;
    ownerUid = found.uid;
    task = found.task;
  }
  // Truncate result (mirrors old storeTasks.updateTaskStatus).
  const truncatedResult = result !== undefined && result !== null
    ? String(result).slice(0, 8192) : undefined;
  await inboxStore.updateTask(ownerUid, taskId, {
    status,
    result: truncatedResult,
    metadata: metadata ?? null,
  });
  // Return updated task for callers that need it.
  return inboxStore.getTaskSync(ownerUid, taskId);
}

async function cancelTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const CANCELLABLE = new Set(['pending', 'blocked']);
  const queue = require('./queue');

  // Resolve task — scan inboxes to validate permissions.
  let ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
  let task = ownerUid ? inboxStore.getTaskSync(ownerUid, taskId) : null;
  if (!task) {
    const found = await _findTaskInboxAsync(taskId);
    if (!found) return { ok: false, error: 'task not found' };
    ownerUid = found.uid;
    task = found.task;
  }

  if (!supervisor && task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can cancel a task' };
  }
  if (!CANCELLABLE.has(task.status)) {
    return { ok: false, error: 'cannot cancel task in status "' + task.status + '" — only pending/blocked' };
  }

  // Use updateTask (in-place) instead of cancelTask (archives).
  // The old storeTasks kept cancelled tasks in the store with status='cancelled'.
  await inboxStore.updateTask(ownerUid, taskId, {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  });
  return { ok: true };
}

async function interruptTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const queue = require('./queue');

  // Resolve task — scan inboxes to validate permissions.
  let ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
  let task = ownerUid ? inboxStore.getTaskSync(ownerUid, taskId) : null;
  if (!task) {
    const found = await _findTaskInboxAsync(taskId);
    if (!found) return { ok: false, error: 'task not found' };
    ownerUid = found.uid;
    task = found.task;
  }

  if (!supervisor && task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can interrupt a task' };
  }
  if (task.status !== 'in_progress') {
    return { ok: false, error: 'cannot interrupt task in status "' + task.status + '" — only in-progress' };
  }

  // Use updateTask (in-place) instead of interruptTask (archives).
  await inboxStore.updateTask(ownerUid, taskId, {
    status: 'interrupted',
    interrupted_at: new Date().toISOString(),
  });
  return { ok: true };
}

async function setTaskWorkflowMeta(taskId, workflowId, stageId) {
  const queue = require('./queue');
  let ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
  if (!ownerUid) {
    const found = await _findTaskInboxAsync(taskId);
    if (!found) return false;
    ownerUid = found.uid;
  }
  await inboxStore.updateTask(ownerUid, taskId, { workflow_id: workflowId, stage_id: stageId });
  return true;
}

async function incrementTaskRetryCount(taskId) {
  const queue = require('./queue');
  let ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
  let task = ownerUid ? inboxStore.getTaskSync(ownerUid, taskId) : null;
  if (!task) {
    const found = await _findTaskInboxAsync(taskId);
    if (!found) return { ok: false, count: 0 };
    ownerUid = found.uid;
    task = found.task;
  }
  const count = (task.retry_count || 0) + 1;
  // Reset to pending + clear result (mirrors old storeTasks.incrementTaskRetryCount).
  await inboxStore.updateTask(ownerUid, taskId, {
    retry_count: count,
    status: 'pending',
    result: null,
    claimed_at: null,
  });
  return { ok: true, count };
}

function findTask(taskId) {
  const found = _findTaskInbox(taskId);
  if (!found) return null;
  const { task: t, uid } = found;

  // Compute queue_position: position in the sorted pending queue.
  let queue_position = 0;
  try {
    const inbox = inboxStore.loadInboxSync(uid);
    const PRIO = { high: 0, normal: 1, low: 2 };
    inbox.pending.sort((a, b) => {
      const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1;
      return pa !== pb ? pa - pb : (a.created_at || '').localeCompare(b.created_at || '');
    });
    queue_position = inbox.pending.findIndex(x => x.task_id === taskId);
    if (queue_position < 0) queue_position = 0;
  } catch {}

  return { task: t, queue_position };
}

async function listAllTasksInWorkspace(workspace) {
  // Scan all inbox files for tasks where sender or receiver is in workspace.
  // The old storeTasks used agent-bus.json; now we scan per-agent inboxes.
  const registry = require('./registry');
  const agents = registry.listAgentsInWorkspace(workspace);
  const wsUids = new Set(agents.map(a => a.uid));
  if (wsUids.size === 0) return [];

  const all = [];
  try {
    const fs = require('fs');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const inbox = inboxStore.loadInboxSync(f.replace('.json', ''));
        for (const t of [...inbox.pending, ...inbox.in_progress]) {
          if (wsUids.has(t.sender_uid) || wsUids.has(t.receiver_uid)) {
            all.push(t);
          }
        }
      } catch {}
    }
  } catch {}
  all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return all;
}

async function pruneOldTasks(olderThanMs = 7 * 24 * 3600_000) {
  // Inbox-based pruning: scan all inboxes, archive tasks older than threshold.
  // Only prunes terminal-status tasks (completed, cancelled, exhausted).
  // Returns the count of pruned tasks.
  const TERMINAL = new Set(['completed', 'cancelled', 'exhausted']);
  let totalPruned = 0;
  try {
    const fs = require('fs/promises');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    let files;
    try { files = await fs.readdir(inboxDir); } catch { return 0; }
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      try {
        const inbox = await inboxStore.loadInbox(uid);
        const beforeP = inbox.pending.length;
        const beforeI = inbox.in_progress.length;
        inbox.pending = inbox.pending.filter(t => {
          if (!TERMINAL.has(t.status)) return true; // keep non-terminal
          const ts = new Date(t.created_at || 0).getTime();
          return (now - ts) < olderThanMs; // keep if younger than threshold
        });
        inbox.in_progress = inbox.in_progress.filter(t => {
          if (!TERMINAL.has(t.status)) return true;
          const ts = new Date(t.created_at || 0).getTime();
          return (now - ts) < olderThanMs;
        });
        const pruned = (beforeP + beforeI) - (inbox.pending.length + inbox.in_progress.length);
        if (pruned > 0) {
          await inboxStore.saveInbox(uid, inbox);
          totalPruned += pruned;
        }
      } catch {}
    }
  } catch {}
  return totalPruned;
}

module.exports = {
  // DB lifecycle
  getDb, closeDb, DB_PATH, DATA_DIR,
  // Agents
  findAgentByNameWs, getAgent, insertAgent, touchAgent, deleteAgent, migrateAgentUid,
  listAgentsInWorkspace, listAllAgentsInWorkspace, listAllAgents, countStaleAgents,
  // Tasks — unified inboxStore backend (Sprint 39)
  genTaskId,
  getTask: _taskOps.getTask,
  getTaskAsync: _taskOps.getTaskAsync,
  listActiveTasks: _taskOps.listActiveTasks,
  countPendingTasks: _taskOps.countPendingTasks,
  listMyTasks: _taskOps.listMyTasks,
  insertTask, getPendingTask, listPendingTasks, listAllPendingQueues,
  getPendingTaskAsync, listPendingTasksAsync, claimPendingTaskAsync,
  updateTaskStatus, cancelTaskAtomic, interruptTaskAtomic,
  setTaskWorkflowMeta, incrementTaskRetryCount, findTask,
  listAllTasksInWorkspace, pruneOldTasks,
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

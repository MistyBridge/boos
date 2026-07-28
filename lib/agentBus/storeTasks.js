// Task CRUD + queries + archival for the agent-bus JSON store.
//
// All writes serialize through withFileLock — no TOCTOU races.
// Imported and re-exported by store.js. Uses storeCore (no circular require).

'use strict';

const path = require('path');
const fs = require('node:fs/promises');
const { _load, _syncLoad, _save, DB_PATH, DATA_DIR, withFileLock } = require('./storeCore');

// ── task CRUD ────────────────────────────────────────────────────────────

async function insertTask(task) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    db.tasks[task.task_id] = {
      task_id: task.task_id, sender_uid: task.sender_uid,
      sender_name: (task.sender_name || '').slice(0, 64),
      sender_intro: (task.sender_intro || '').slice(0, 256),
      receiver_uid: task.receiver_uid, content: task.content,
      priority: task.priority || 'normal', status: task.status,
      result: task.result || null, workflow_id: task.workflow_id || null,
      stage_id: task.stage_id || null, reply_to: task.reply_to || null,
      message_type: task.message_type || 'request',
      required_capabilities: task.required_capabilities || [],
      matched_via: task.matched_via || 'direct',
      metadata: task.metadata || null, retry_count: task.retry_count || 0,
      created_at: task.created_at, updated_at: task.updated_at || null,
    };
    await _save(db);
    return task;
  });
}

function getTask(taskId) {
  return _syncLoad().tasks[taskId] || null;
}

async function getTaskAsync(taskId) {
  const db = await _load();
  return db.tasks[taskId] || null;
}

function getPendingTask(receiverUid) {
  const db = _syncLoad();
  const PRIO = { high: 0, normal: 1, low: 2 };
  const pending = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
  return pending[0] || null;
}

function listPendingTasks(receiverUid) {
  const db = _syncLoad();
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
}

function listAllPendingQueues() {
  const db = _syncLoad();
  const queueUids = new Set();
  for (const task of Object.values(db.tasks)) {
    if (task.status === 'pending' && task.receiver_uid) queueUids.add(task.receiver_uid);
  }
  return Array.from(queueUids);
}

function listActiveTasks(receiverUid) {
  const db = _syncLoad();
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && (t.status === 'pending' || t.status === 'in_progress'))
    .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
}

async function getPendingTaskAsync(receiverUid) {
  const db = await _load();
  const PRIO = { high: 0, normal: 1, low: 2 };
  const pending = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
  return pending[0] || null;
}

async function listPendingTasksAsync(receiverUid) {
  const db = await _load();
  const PRIO = { high: 0, normal: 1, low: 2 };
  return Object.values(db.tasks)
    .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
    .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
}

async function claimPendingTaskAsync(receiverUid) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const PRIO = { high: 0, normal: 1, low: 2 };
    const pending = Object.values(db.tasks)
      .filter((t) => t.receiver_uid === receiverUid && t.status === 'pending')
      .sort((a, b) => { const pa = PRIO[a.priority] ?? 1, pb = PRIO[b.priority] ?? 1; return pa !== pb ? pa - pb : a.created_at.localeCompare(b.created_at); });
    const task = pending[0];
    if (!task) return null;
    task.status = 'in_progress';
    task.updated_at = new Date().toISOString();
    await _save(db);
    return task;
  });
}

function countPendingTasks(receiverUid) {
  return Object.values(_syncLoad().tasks).filter((t) => t.receiver_uid === receiverUid && t.status === 'pending').length;
}

// ── Task mutations ───────────────────────────────────────────────────────

async function updateTaskStatus(taskId, status, result, metadata) {
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return;
    task.status = status;
    task.updated_at = new Date().toISOString();
    if (result !== undefined && result !== null) task.result = result.slice(0, 8192);
    if (metadata !== undefined && metadata !== null) task.metadata = metadata;
    await _save(db);
  });
}

async function cancelTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const CANCELLABLE = new Set(['pending', 'blocked']);
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return { ok: false, error: 'task not found' };
    if (!supervisor && task.sender_uid !== requesterUid) {
      return { ok: false, error: 'only the sender can cancel a task' };
    }
    if (!CANCELLABLE.has(task.status)) {
      return { ok: false, error: 'cannot cancel task in status "' + task.status + '" — only pending/blocked' };
    }
    task.status = 'cancelled';
    task.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true };
  });
}

async function interruptTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  return withFileLock(DB_PATH, async () => {
    const db = await _load();
    const task = db.tasks[taskId];
    if (!task) return { ok: false, error: 'task not found' };
    if (!supervisor && task.sender_uid !== requesterUid) {
      return { ok: false, error: 'only the sender can interrupt a task' };
    }
    if (task.status !== 'in_progress') {
      return { ok: false, error: 'cannot interrupt task in status "' + task.status + '" — only in-progress' };
    }
    task.status = 'interrupted';
    task.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true };
  });
}

async function setTaskWorkflowMeta(taskId, workflowId, stageId) {
  return withFileLock(DB_PATH, async () => {
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

async function incrementTaskRetryCount(taskId) {
  return withFileLock(DB_PATH, async () => {
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

// ── Task queries ─────────────────────────────────────────────────────────

function listMyTasks(uid) {
  return Object.values(_syncLoad().tasks)
    .filter((t) => t.sender_uid === uid || t.receiver_uid === uid)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function listAllTasksInWorkspace(workspace) {
  const db = _syncLoad();
  return Object.values(db.tasks || {})
    .filter((t) => {
      const sender = db.agents[t.sender_uid];
      const receiver = db.agents[t.receiver_uid];
      return (sender && sender.workspace === workspace) || (receiver && receiver.workspace === workspace);
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function findTask(taskId) {
  const db = _syncLoad();
  const task = db.tasks[taskId];
  if (!task) return null;
  const ahead = Object.values(db.tasks)
    .filter((t) => t.receiver_uid === task.receiver_uid && t.status === 'pending' && t.created_at < task.created_at)
    .length;
  return { task, queue_position: ahead };
}

// ── Task archival ────────────────────────────────────────────────────────

const ARCHIVE_DIR = path.join(DATA_DIR, 'archive', 'tasks');

async function _ensureArchiveDir() {
  try { await fs.mkdir(ARCHIVE_DIR, { recursive: true }); } catch {}
}

async function pruneOldTasks(maxAgeMs = 7 * 24 * 3600_000) {
  return withFileLock(DB_PATH, async () => {
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
    await _ensureArchiveDir();
    const archiveFile = path.join(ARCHIVE_DIR, `tasks-${new Date().toISOString().slice(0, 10)}.jsonl`);
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
  insertTask, getTask, getTaskAsync, getPendingTask, listPendingTasks,
  listAllPendingQueues, listActiveTasks, getPendingTaskAsync, listPendingTasksAsync,
  claimPendingTaskAsync, countPendingTasks,
  updateTaskStatus, cancelTaskAtomic, interruptTaskAtomic,
  setTaskWorkflowMeta, incrementTaskRetryCount,
  listMyTasks, findTask, listAllTasksInWorkspace,
  pruneOldTasks,
};

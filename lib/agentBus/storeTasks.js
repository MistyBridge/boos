// Task operations — unified inboxStore backend.
//
// Extracted from store.js — Sprint 41 Phase 3 refactor.
// All task data lives in per-agent inbox files (inboxStore).
// The old shared agent-bus.json task store was removed in Sprint 35.

'use strict';

const inboxStore = require('./inboxStore');

// ── inbox scan helpers (shared across task ops) ───────────────────────

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

// ── _taskOps wrapper ──────────────────────────────────────────────────
// Bridges old API (store.getTask / store.listActiveTasks / etc.) to
// inboxStore. All task data lives exclusively in per-agent inbox files.

const _taskOps = {
  getTask(taskId) {
    const queue = require('./queue');
    const ownerUid = queue._findTaskOwner ? queue._findTaskOwner(taskId) : null;
    if (ownerUid) {
      const t = inboxStore.getTaskSync(ownerUid, taskId);
      if (t) return t;
    }
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
    try {
      const inbox = inboxStore.loadInboxSync(uid);
      return [...inbox.pending, ...inbox.in_progress];
    } catch {}
    return [];
  },

  async countPendingTasks(uid) {
    return await inboxStore.countPending(uid);
  },

  async listMyTasks(uid) {
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

// ── synchronous task ops ──────────────────────────────────────────────

function getPendingTask(uid) {
  try {
    const inbox = inboxStore.loadInboxSync(uid);
    const PRIO = { high: 0, normal: 1, low: 2 };
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

// ── async task ops ────────────────────────────────────────────────────

async function insertTask(task) {
  const normalized = {
    ...task,
    sender_name: (task.sender_name || '').slice(0, 64),
    sender_intro: (task.sender_intro || '').slice(0, 256),
    content: (task.content || '').slice(0, 4096),
    result: task.result ? String(task.result).slice(0, 8192) : null,
  };
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
  const truncatedResult = result !== undefined && result !== null
    ? String(result).slice(0, 8192) : undefined;
  await inboxStore.updateTask(ownerUid, taskId, {
    status,
    result: truncatedResult,
    metadata: metadata ?? null,
  });
  return inboxStore.getTaskSync(ownerUid, taskId);
}

async function cancelTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const CANCELLABLE = new Set(['pending', 'blocked']);
  const queue = require('./queue');

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

  await inboxStore.updateTask(ownerUid, taskId, {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  });
  return { ok: true };
}

async function interruptTaskAtomic(taskId, requesterUid, opts = {}) {
  const supervisor = opts.supervisor || false;
  const queue = require('./queue');

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
          if (!TERMINAL.has(t.status)) return true;
          const ts = new Date(t.created_at || 0).getTime();
          return (now - ts) < olderThanMs;
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
  getTask: _taskOps.getTask,
  getTaskAsync: _taskOps.getTaskAsync,
  listActiveTasks: _taskOps.listActiveTasks,
  countPendingTasks: _taskOps.countPendingTasks,
  listMyTasks: _taskOps.listMyTasks,
  insertTask,
  getPendingTask, listPendingTasks, listAllPendingQueues,
  getPendingTaskAsync, listPendingTasksAsync, claimPendingTaskAsync,
  updateTaskStatus, cancelTaskAtomic, interruptTaskAtomic,
  setTaskWorkflowMeta, incrementTaskRetryCount, findTask,
  listAllTasksInWorkspace, pruneOldTasks,
};

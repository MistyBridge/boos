// Per-agent FIFO task queue — persisted via store.js.
//
// Adapted from agent-bus/lib/queue.js. Changed: require('./store') path.

'use strict';

const EventEmitter = require('events');
const store = require('./store');

const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(200);

const ST_PENDING     = 'pending';
const ST_IN_PROGRESS = 'in_progress';
const ST_COMPLETED   = 'completed';
const ST_CANCELLED   = 'cancelled';
const ST_INTERRUPTED = 'interrupted';

const CANCELLABLE   = new Set([ST_PENDING]);
const INTERRUPTIBLE = new Set([ST_IN_PROGRESS]);
const RESPONDABLE   = new Set([ST_IN_PROGRESS]);

function sendTask({ task_id, sender, receiver_uid, content, priority }) {
  if (!sender || !sender.uid || !receiver_uid || !content) {
    return { ok: false, error: 'sender (uid,name,intro), receiver_uid, and content are required' };
  }
  if (sender.uid === receiver_uid) {
    return { ok: false, error: 'cannot send task to yourself' };
  }

  const receiver = store.getAgent(receiver_uid);
  if (!receiver) {
    return { ok: false, error: 'receiver agent "' + receiver_uid + '" not found in registry' };
  }

  const wasEmpty = store.countPendingTasks(receiver_uid) === 0;

  const task = {
    task_id: task_id || store.genTaskId(),
    sender_uid: sender.uid,
    sender_name: (sender.name || '').slice(0, 64),
    sender_intro: (sender.intro || '').slice(0, 256),
    receiver_uid,
    content: content.slice(0, 4096),
    priority: priority || 'normal',
    status: ST_PENDING,
    created_at: new Date().toISOString(),
  };

  store.insertTask(task);

  if (wasEmpty) {
    inboxEvents.emit('task_available', receiver_uid);
  }

  return { ok: true, task: _toExternal(task), was_empty: wasEmpty };
}

function cancelTask(taskId, requesterUid) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can cancel a task' };
  }
  if (!CANCELLABLE.has(task.status)) {
    return { ok: false, error: 'cannot cancel task in status "' + task.status + '" — only pending tasks can be cancelled' };
  }
  store.updateTaskStatus(taskId, ST_CANCELLED, null);
  return { ok: true };
}

function interruptTask(taskId, requesterUid) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can interrupt a task' };
  }
  if (!INTERRUPTIBLE.has(task.status)) {
    return { ok: false, error: 'cannot interrupt task in status "' + task.status + '" — only in-progress tasks can be interrupted' };
  }
  store.updateTaskStatus(taskId, ST_INTERRUPTED, null);
  return { ok: true };
}

function checkInbox(uid) {
  const task = store.getPendingTask(uid);
  if (!task) return null;
  store.updateTaskStatus(task.task_id, ST_IN_PROGRESS, null);
  task.status = ST_IN_PROGRESS;
  return _toExternal(task);
}

function respondTask(taskId, requesterUid, result) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.receiver_uid !== requesterUid) {
    return { ok: false, error: 'only the assigned receiver can respond to a task' };
  }
  if (!RESPONDABLE.has(task.status)) {
    return { ok: false, error: 'task is in status "' + task.status + '" — must be in_progress to respond' };
  }
  store.updateTaskStatus(taskId, ST_COMPLETED, result || '');
  return { ok: true };
}

function getTask(taskId) {
  const task = store.getTask(taskId);
  return task ? _toExternal(task) : null;
}

function listMyTasks(uid) {
  return store.listMyTasks(uid).map(_toExternal);
}

function broadcast(workspace, senderUid, message, receiverUids) {
  if (!receiverUids || receiverUids.length === 0) {
    return { ok: true, sent: 0, errors: [] };
  }
  const errors = [];
  let sent = 0;
  const targets = receiverUids.filter((uid) => uid !== senderUid);

  for (const receiverUid of targets) {
    const r = sendTask({
      sender: { uid: senderUid, name: 'broadcast', intro: 'Broadcast to workspace ' + workspace },
      receiver_uid: receiverUid,
      content: '[BROADCAST from ' + workspace + ']\n' + message,
      priority: 'normal',
    });
    if (r.ok) { sent++; } else { errors.push(receiverUid + ': ' + r.error); }
  }
  return { ok: errors.length === 0, sent, errors };
}

function waitForTask(uid, timeoutMs) {
  const maxWait = Math.min(timeoutMs || 30000, 120000);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inboxEvents.removeListener('task_available', handler);
      resolve(null);
    }, maxWait);

    const handler = (notifiedUid) => {
      if (notifiedUid === uid) {
        clearTimeout(timer);
        inboxEvents.removeListener('task_available', handler);
        resolve(checkInbox(uid));
      }
    };

    inboxEvents.on('task_available', handler);
  });
}

// ── supervisor privilege operations (Sprint 5) ─────────────────────────

function supervisorCancelTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!CANCELLABLE.has(task.status)) {
    return { ok: false, error: 'cannot cancel task in status "' + task.status + '"' };
  }
  store.updateTaskStatus(taskId, ST_CANCELLED, null);
  return { ok: true };
}

function supervisorInterruptTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!INTERRUPTIBLE.has(task.status)) {
    return { ok: false, error: 'cannot interrupt task in status "' + task.status + '"' };
  }
  store.updateTaskStatus(taskId, ST_INTERRUPTED, null);
  return { ok: true };
}

function cancelAllTasksForAgent(uid) {
  // Iterate and cancel all pending/in_progress tasks for the agent.
  let count = 0;
  const tasks = store.listMyTasks(uid);
  for (const t of tasks) {
    if (t.status === 'pending' || t.status === 'in_progress') {
      store.updateTaskStatus(t.task_id, ST_CANCELLED, null);
      count++;
    }
  }
  return count;
}

// ── helpers ────────────────────────────────────────────────────────────

function _toExternal(task) {
  if (!task) return null;
  return {
    task_id: task.task_id,
    sender: {
      uid: task.sender_uid,
      name: task.sender_name,
      intro: task.sender_intro || '',
    },
    receiver_uid: task.receiver_uid,
    content: task.content,
    priority: task.priority,
    status: task.status,
    result: task.result,
    workflow_id: task.workflow_id || null,
    stage_id: task.stage_id || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

module.exports = {
  sendTask, cancelTask, interruptTask, checkInbox, respondTask,
  getTask, listMyTasks, broadcast, waitForTask, inboxEvents,
  supervisorCancelTask, supervisorInterruptTask, cancelAllTasksForAgent,
  ST_PENDING, ST_IN_PROGRESS, ST_COMPLETED, ST_CANCELLED, ST_INTERRUPTED,
};

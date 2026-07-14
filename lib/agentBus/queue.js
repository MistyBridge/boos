// Per-agent FIFO task queue — persisted via store.js.
//
// Adapted from agent-bus/lib/queue.js. Changed: require('./store') path.

'use strict';

const EventEmitter = require('events');
const store = require('./store');
const collaborationLoop = require('./collaborationLoop');
const taskAnalytics = require('./taskAnalytics');

const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(200);

// outboxEvents: emitted when a task transitions to completed.
// Subscribers (notifications.js) use this to notify the sender via PTY.
const outboxEvents = new EventEmitter();
outboxEvents.setMaxListeners(200);

const ST_PENDING     = 'pending';
const ST_IN_PROGRESS = 'in_progress';
const ST_COMPLETED   = 'completed';
const ST_CANCELLED   = 'cancelled';
const ST_INTERRUPTED = 'interrupted';
const ST_EXHAUSTED   = 'exhausted';

const CANCELLABLE   = new Set([ST_PENDING]);
const INTERRUPTIBLE = new Set([ST_IN_PROGRESS]);
const RESPONDABLE   = new Set([ST_IN_PROGRESS]);
const RETRYABLE     = new Set([ST_COMPLETED, ST_CANCELLED]);
const MAX_RETRIES   = 3;

function sendTask({ task_id, sender, receiver_uid, content, priority, reply_to, required_capabilities }) {
  if (!sender || !sender.uid || !content) {
    return { ok: false, error: 'sender (uid,name,intro) and content are required' };
  }

  // Auto-route by capability if no specific receiver_uid given.
  let targetUid = receiver_uid;
  let matchedVia = receiver_uid ? 'direct' : null;

  if (!receiver_uid && required_capabilities && required_capabilities.length > 0) {
    const agents = store.listAgentsInWorkspace(sender.workspace || '');
    targetUid = _matchByCapability(agents, required_capabilities, sender.uid);
    matchedVia = targetUid ? 'capability' : null;
  }

  if (!targetUid) {
    return { ok: false, error: 'no matching agent found for capabilities: ' + (required_capabilities || []).join(', ') };
  }
  if (targetUid === sender.uid) {
    return { ok: false, error: 'cannot send task to yourself' };
  }

  const receiver = store.getAgent(targetUid);
  if (!receiver) {
    return { ok: false, error: 'receiver agent "' + targetUid + '" not found in registry' };
  }

  // Work boundary check: if task requires capabilities the receiver doesn't have,
  // reject unless receiver is the generalist agent.
  if (required_capabilities && required_capabilities.length > 0) {
    const receiverCaps = new Set(receiver.capabilities || []);
    const isGeneralist = receiverCaps.has('general');
    if (!isGeneralist) {
      const hasMatch = required_capabilities.some((c) => receiverCaps.has(c));
      if (!hasMatch) {
        return { ok: false, error: 'agent "' + receiver.name + '" does not have required capabilities: ' + required_capabilities.join(', ') };
      }
    }
  }

  const wasEmpty = store.countPendingTasks(targetUid) === 0;

  const task = {
    task_id: task_id || store.genTaskId(),
    sender_uid: sender.uid,
    sender_name: (sender.name || '').slice(0, 64),
    sender_intro: (sender.intro || '').slice(0, 256),
    receiver_uid: targetUid,
    content: content.slice(0, 4096),
    priority: priority || 'normal',
    status: ST_PENDING,
    reply_to: reply_to || null,
    required_capabilities: required_capabilities || [],
    matched_via: matchedVia,
    created_at: new Date().toISOString(),
  };

  store.insertTask(task);

  if (wasEmpty) {
    inboxEvents.emit('task_available', targetUid);
  }

  // Sprint 8 #73: track capability distribution for recruitment suggestions.
  if (required_capabilities && required_capabilities.length > 0) {
    taskAnalytics.track(required_capabilities);
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
  collaborationLoop.refreshState(uid);
  return _toExternal(task);
}

async function respondTask(taskId, requesterUid, result) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.receiver_uid !== requesterUid) {
    return { ok: false, error: 'only the assigned receiver can respond to a task' };
  }
  if (!RESPONDABLE.has(task.status)) {
    return { ok: false, error: 'task is in status "' + task.status + '" — must be in_progress to respond' };
  }
  store.updateTaskStatus(taskId, ST_COMPLETED, result || '');
  collaborationLoop.refreshState(requesterUid);
  // Emit for outbound notification — sender gets PTY message.
  outboxEvents.emit('task_completed', {
    task_id: taskId,
    sender_uid: task.sender_uid,
    receiver_uid: task.receiver_uid,
    receiver_name: store.getAgent(requesterUid)?.name || '',
    result: result || '',
  });
  // Chain trigger: if this task is part of a workflow, cascade to next stages.
  if (task.workflow_id || task.stage_id) {
    try {
      const wf = require('../workflowEngine');
      await wf.onStageCompleted(taskId);
    } catch {}
  }
  return { ok: true };
}

function retryTask(taskId, requesterUid) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can retry a task' };
  }
  if (!RETRYABLE.has(task.status)) {
    return { ok: false, error: 'only completed or cancelled tasks can be retried (status: ' + task.status + ')' };
  }
  const count = (task.retry_count || 0) + 1;
  if (count > MAX_RETRIES) {
    store.updateTaskStatus(taskId, ST_EXHAUSTED,
      'Max retries (' + MAX_RETRIES + ') exceeded. Last attempt was #' + (count - 1) + '.');
    return { ok: false, error: 'max retries (' + MAX_RETRIES + ') exceeded — task marked exhausted', exhausted: true };
  }
  // Reset: back to pending, bump retry_count, clear old result.
  store.updateTaskStatus(taskId, ST_PENDING, null);
  // Update retry_count via raw DB write (updateTaskStatus doesn't touch retry_count).
  const db = require('fs').existsSync(store.DB_PATH)
    ? JSON.parse(require('fs').readFileSync(store.DB_PATH, 'utf-8'))
    : { tasks: {} };
  if (db.tasks[taskId]) {
    db.tasks[taskId].retry_count = count;
    require('fs').writeFileSync(store.DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  }
  collaborationLoop.refreshState(task.receiver_uid);
  inboxEvents.emit('task_available', task.receiver_uid);
  return { ok: true, retry_count: count, remaining: MAX_RETRIES - count };
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

function _matchByCapability(agents, requiredCaps, senderUid) {
  // Delegate to collaborationLoop for idle-preference ranking.
  if (requiredCaps && requiredCaps.length > 0) {
    return collaborationLoop.findBestAgent(agents, requiredCaps, senderUid);
  }
  return null;
}

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
    reply_to: task.reply_to || null,
    required_capabilities: task.required_capabilities || [],
    matched_via: task.matched_via || 'direct',
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

module.exports = {
  sendTask, cancelTask, interruptTask, checkInbox, respondTask, retryTask,
  getTask, listMyTasks, broadcast, waitForTask,
  inboxEvents, outboxEvents,
  supervisorCancelTask, supervisorInterruptTask, cancelAllTasksForAgent,
  ST_PENDING, ST_IN_PROGRESS, ST_COMPLETED, ST_CANCELLED, ST_INTERRUPTED, ST_EXHAUSTED,
  MAX_RETRIES,
};

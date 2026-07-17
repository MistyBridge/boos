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
const ST_BLOCKED     = 'blocked';       // Sprint 9: agent waiting for human decision

const CANCELLABLE   = new Set([ST_PENDING, ST_BLOCKED]);
const INTERRUPTIBLE = new Set([ST_IN_PROGRESS]);
const RESPONDABLE   = new Set([ST_IN_PROGRESS]);
const RETRYABLE     = new Set([ST_COMPLETED, ST_CANCELLED]);
const BLOCKABLE     = new Set([ST_IN_PROGRESS]);  // only in-progress tasks can be blocked
const UNBLOCKABLE   = new Set([ST_BLOCKED]);      // blocked → in_progress
const MAX_RETRIES   = 3;

async function sendTask({ task_id, sender, receiver_uid, content, priority, reply_to, required_capabilities }) {
  if (!sender || !sender.uid || !content) {
    return { ok: false, error: 'sender (uid,name,intro) and content are required' };
  }

  // Auto-route by capability if no specific receiver_uid given.
  let targetUid = receiver_uid;
  let matchedVia = receiver_uid ? 'direct' : null;
  let splitTasks = []; // Sprint 10 R14: sub-tasks from capability split.

  if (!receiver_uid && required_capabilities && required_capabilities.length > 0) {
    const agents = store.listAgentsInWorkspace(sender.workspace || '');
    // Sprint 10 R14: if multiple capabilities and no single agent covers all,
    // split into sub-tasks, one per capability.
    if (required_capabilities.length > 1) {
      const uncovered = [];
      for (const cap of required_capabilities) {
        const match = _matchByCapability(agents, [cap], sender.uid);
        if (match) {
          // Don't create duplicate tasks for the same agent.
          if (!splitTasks.find((t) => t.receiver_uid === match)) {
            splitTasks.push({ capability: cap, receiver_uid: match });
          }
        } else {
          uncovered.push(cap);
        }
      }
      // If all capabilities covered by split → use first match as primary.
      if (splitTasks.length > 0) {
        targetUid = splitTasks[0].receiver_uid;
        matchedVia = 'capability-split';
        // Remove the primary capability from sub-task list.
        const primaryCap = splitTasks[0].capability;
        splitTasks = splitTasks.slice(1).filter((t) => t.capability !== primaryCap);
      }
      // Remaining uncovered → route to PM (supervisor) or generalist.
      if (uncovered.length > 0 && !targetUid) {
        targetUid = _findSupervisor(agents) || _findGeneralist(agents);
        matchedVia = 'fallback-pm';
      }
    } else {
      targetUid = _matchByCapability(agents, required_capabilities, sender.uid);
      matchedVia = targetUid ? 'capability' : null;
    }
  }

  // Sprint 10 R14: no match → route to PM/supervisor instead of failing.
  if (!targetUid) {
    const agents = store.listAgentsInWorkspace(sender.workspace || '');
    targetUid = _findSupervisor(agents) || _findGeneralist(agents);
    if (targetUid) {
      matchedVia = 'fallback-pm';
    } else {
      return { ok: false, error: 'no agent available in workspace' };
    }
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

  await store.insertTask(task);

  // Sprint 11: always emit — no more manual wake_agent needed.
  // notifications.js handles debounce (1s burst window).
  inboxEvents.emit('task_available', targetUid);

  // Sprint 10 R14: create sub-tasks for unmatched capabilities.
  const subTaskIds = [];
  if (splitTasks.length > 0) {
    for (const st of splitTasks) {
      const sub = {
        task_id: store.genTaskId(),
        sender_uid: sender.uid,
        sender_name: (sender.name || '').slice(0, 64),
        sender_intro: (sender.intro || '').slice(0, 256),
        receiver_uid: st.receiver_uid,
        content: `[子任务 · 需要 ${st.capability}] ${content.slice(0, 3900)}`,
        priority: priority || 'normal',
        status: ST_PENDING,
        reply_to: task.task_id, // link to parent
        required_capabilities: [st.capability],
        matched_via: 'capability-split',
        created_at: new Date().toISOString(),
      };
      await store.insertTask(sub);
      subTaskIds.push(sub.task_id);
      // Sprint 11: always auto-notify sub-task receivers too.
      inboxEvents.emit('task_available', st.receiver_uid);
    }
  }

  // Sprint 8 #73: track capability distribution for recruitment suggestions.
  if (required_capabilities && required_capabilities.length > 0) {
    taskAnalytics.track(required_capabilities);
  }

  return {
    ok: true,
    task: _toExternal(task),
    was_empty: wasEmpty,
    sub_tasks: subTaskIds.length > 0 ? subTaskIds : undefined,
    routed_via: matchedVia,
  };
}

async function cancelTask(taskId, requesterUid) {
  // Sprint 16: atomic read-validate-write via store.cancelTaskAtomic.
  // Eliminates TOCTOU race between getTask (sync) and updateTaskStatus (async).
  return store.cancelTaskAtomic(taskId, requesterUid);
}

async function interruptTask(taskId, requesterUid) {
  // Sprint 16: atomic read-validate-write via store.interruptTaskAtomic.
  return store.interruptTaskAtomic(taskId, requesterUid);
}

async function checkInbox(uid) {
  // Sprint 10: touch heartbeat so crash scanner knows this agent is alive.
  // Sprint 13.3: await to ensure withFileLock completes before returning.
  try { await require('./heartbeat').touch(uid); } catch {}

  // Sprint 6 P0 fix: claimPendingTaskAsync is atomic (single withFileLock)
  // — eliminates the TOCTOU race between getPendingTaskAsync and updateTaskStatus.
  const task = await store.claimPendingTaskAsync(uid);
  if (!task) return null;
  collaborationLoop.refreshState(uid);
  return _toExternal(task);
}

async function respondTask(taskId, requesterUid, result) {
  const task = await store.getTaskAsync(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.receiver_uid !== requesterUid) {
    return { ok: false, error: 'only the assigned receiver can respond to a task' };
  }
  if (!RESPONDABLE.has(task.status)) {
    return { ok: false, error: 'task is in status "' + task.status + '" — must be in_progress to respond' };
  }
  await store.updateTaskStatus(taskId, ST_COMPLETED, result || '');
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

async function retryTask(taskId, requesterUid) {
  const task = await store.getTaskAsync(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (task.sender_uid !== requesterUid) {
    return { ok: false, error: 'only the sender can retry a task' };
  }
  if (!RETRYABLE.has(task.status)) {
    return { ok: false, error: 'only completed or cancelled tasks can be retried (status: ' + task.status + ')' };
  }
  const count = (task.retry_count || 0) + 1;
  if (count > MAX_RETRIES) {
    await store.updateTaskStatus(taskId, ST_EXHAUSTED,
      'Max retries (' + MAX_RETRIES + ') exceeded. Last attempt was #' + (count - 1) + '.');
    return { ok: false, error: 'max retries (' + MAX_RETRIES + ') exceeded — task marked exhausted', exhausted: true };
  }
  // #83 fix: use atomic withFileLock instead of raw file I/O.
  const result = await store.incrementTaskRetryCount(taskId);
  if (!result.ok) {
    return { ok: false, error: "failed to update retry_count" };
  }
  collaborationLoop.refreshState(task.receiver_uid);
  inboxEvents.emit("task_available", task.receiver_uid);
  return { ok: true, retry_count: result.count, remaining: MAX_RETRIES - result.count };
}

function getTask(taskId) {
  const task = store.getTask(taskId);
  return task ? _toExternal(task) : null;
}

function listMyTasks(uid) {
  return store.listMyTasks(uid).map(_toExternal);
}

// M1: List all agents with pending tasks (non-empty queues)
function listAllPendingQueues() {
  return store.listAllPendingQueues();
}

// M1: Quick check if a specific agent has pending tasks
function hasPendingTasks(uid) {
  return store.countPendingTasks(uid) > 0;
}

async function broadcast(workspace, senderUid, message, receiverUids) {
  if (!receiverUids || receiverUids.length === 0) {
    return { ok: true, sent: 0, errors: [] };
  }
  const errors = [];
  let sent = 0;
  const targets = receiverUids.filter((uid) => uid !== senderUid);

  for (const receiverUid of targets) {
    const r = await sendTask({
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

    const handler = async (notifiedUid) => {
      if (notifiedUid === uid) {
        clearTimeout(timer);
        inboxEvents.removeListener('task_available', handler);
        resolve(await checkInbox(uid));
      }
    };

    inboxEvents.on('task_available', handler);
  });
}

// ── supervisor privilege operations (Sprint 5) ─────────────────────────

async function supervisorCancelTask(taskId) {
  // Sprint 16: atomic read-validate-write via store.cancelTaskAtomic.
  return store.cancelTaskAtomic(taskId, null, { supervisor: true });
}

async function supervisorInterruptTask(taskId) {
  // Sprint 16: atomic read-validate-write via store.interruptTaskAtomic.
  return store.interruptTaskAtomic(taskId, null, { supervisor: true });
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

// Sprint 10 R14: find supervisor agent (role=supervisor) for fallback routing.
function _findSupervisor(agents) {
  const sup = agents.find((a) => a.role === 'supervisor');
  return sup ? sup.uid : null;
}

// Sprint 10 R14: find generalist agent for fallback routing.
function _findGeneralist(agents) {
  const gen = agents.find((a) => (a.capabilities || []).includes('general'));
  return gen ? gen.uid : null;
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

// ── Sprint 9: task blocking (human decision gate) ──────────────────

async function blockTask(taskId, reason) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!BLOCKABLE.has(task.status)) {
    return { ok: false, error: 'cannot block task in status "' + task.status + '" — only in_progress tasks can be blocked' };
  }
  await store.updateTaskStatus(taskId, ST_BLOCKED, reason || 'blocked on decision');
  collaborationLoop.refreshState(task.receiver_uid);
  return { ok: true };
}

async function unblockTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!UNBLOCKABLE.has(task.status)) {
    return { ok: false, error: 'cannot unblock task in status "' + task.status + '" — only blocked tasks can be unblocked' };
  }
  await store.updateTaskStatus(taskId, ST_IN_PROGRESS, null);
  collaborationLoop.refreshState(task.receiver_uid);
  // Notify agent that blocked task is now ready.
  inboxEvents.emit('task_available', task.receiver_uid);
  return { ok: true };
}

module.exports = {
  sendTask, cancelTask, interruptTask, checkInbox, respondTask, retryTask,
  blockTask, unblockTask,
  getTask, listMyTasks, listAllPendingQueues, hasPendingTasks, broadcast, waitForTask,
  inboxEvents, outboxEvents,
  supervisorCancelTask, supervisorInterruptTask, cancelAllTasksForAgent,
  ST_PENDING, ST_IN_PROGRESS, ST_COMPLETED, ST_CANCELLED, ST_INTERRUPTED, ST_EXHAUSTED, ST_BLOCKED,
  MAX_RETRIES,
};

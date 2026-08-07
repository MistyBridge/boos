// Per-agent FIFO task queue — backed by inboxStore (per-agent exclusive inbox files).
//
// Sprint 35 refactor: tasks moved from shared agent-bus.json → per-agent inbox/<uid>.json.
// Each agent's pending + in_progress live in a tiny dedicated file (~few KB).
// Completed/cancelled tasks are immediately archived to archive/<uid>.jsonl (append-only).

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const EventEmitter = require('events');
const store = require('./store');
const inboxStore = require('./inboxStore');
const collaborationLoop = require('./collaborationLoop');
const taskAnalytics = require('./taskAnalytics');
const ptyInjectionQueue = require('./ptyInjectionQueue');
const cacheStore = require('./cacheStore');   // Sprint 41: externalized letter content

const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(200);

const outboxEvents = new EventEmitter();
outboxEvents.setMaxListeners(200);

const ST_PENDING     = 'pending';
const ST_IN_PROGRESS = 'in_progress';
const ST_COMPLETED   = 'completed';
const ST_CANCELLED   = 'cancelled';
const ST_INTERRUPTED = 'interrupted';
const ST_EXHAUSTED   = 'exhausted';
const ST_BLOCKED     = 'blocked';
const ST_SUBMITTED   = 'submitted';   // Sprint 37: worker done, awaiting PM settlement

const CANCELLABLE   = new Set([ST_PENDING, ST_BLOCKED]);
const INTERRUPTIBLE = new Set([ST_IN_PROGRESS]);
const RESPONDABLE   = new Set([ST_PENDING, ST_IN_PROGRESS]);
const RETRYABLE     = new Set([ST_COMPLETED, ST_CANCELLED]);
const BLOCKABLE     = new Set([ST_IN_PROGRESS]);
const UNBLOCKABLE   = new Set([ST_BLOCKED]);
const MAX_RETRIES   = 3;

// ── task_id → { receiver_uid } index ────────────────────────────────────
// Lightweight in-memory index so we can find any task's owner without scanning files.
// Rebuilt on startup from all inbox files.

const _taskIndex = new Map(); // task_id → receiver_uid

async function rebuildTaskIndex() {
  _taskIndex.clear();
  try {
    const fs = require('fs/promises');
    const path = require('path');
    const inboxDir = inboxStore.INBOX_DIR;
    let files;
    try { files = await fs.readdir(inboxDir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      try {
        const inbox = await inboxStore.loadInbox(uid);
        for (const t of inbox.pending) _taskIndex.set(t.task_id, uid);
        for (const t of inbox.in_progress) _taskIndex.set(t.task_id, uid);
      } catch (e) { errReport.report("queue", "set", e); }
    }
  } catch (e) { errReport.report("queue", "set", e); }
  console.log('[queue] task index rebuilt:', _taskIndex.size, 'active tasks');
}

function _indexTask(taskId, receiverUid) {
  _taskIndex.set(taskId, receiverUid);
}

function _unindexTask(taskId) {
  _taskIndex.delete(taskId);
}

function _findTaskOwner(taskId) {
  return _taskIndex.get(taskId) || null;
}

// ── core operations ─────────────────────────────────────────────────────

async function sendTask({ task_id, sender, receiver_uid, content, priority, reply_to, message_type, required_capabilities, metadata }) {
  if (!sender || !sender.uid || !content) {
    return { ok: false, error: 'sender (uid,name,intro) and content are required' };
  }

  let targetUid = receiver_uid;
  let matchedVia = receiver_uid ? 'direct' : null;
  let splitTasks = [];

  if (!receiver_uid && required_capabilities && required_capabilities.length > 0) {
    const agents = store.listAgentsInWorkspace(sender.workspace || '');
    if (required_capabilities.length > 1) {
      const uncovered = [];
      for (const cap of required_capabilities) {
        // _matchByCapability is async (calls collaborationLoop.findBestAgent).
        const match = await _matchByCapability(agents, [cap], sender.uid);
        if (match) {
          if (!splitTasks.find((t) => t.receiver_uid === match)) {
            splitTasks.push({ capability: cap, receiver_uid: match });
          }
        } else {
          uncovered.push(cap);
        }
      }
      if (splitTasks.length > 0) {
        targetUid = splitTasks[0].receiver_uid;
        matchedVia = 'capability-split';
        const primaryCap = splitTasks[0].capability;
        splitTasks = splitTasks.slice(1).filter((t) => t.capability !== primaryCap);
      }
      if (uncovered.length > 0 && !targetUid) {
        targetUid = _findSupervisor(agents) || _findGeneralist(agents);
        matchedVia = 'fallback-pm';
      }
    } else {
      targetUid = await _matchByCapability(agents, required_capabilities, sender.uid);
      matchedVia = targetUid ? 'capability' : null;
    }
  }

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

  const wasEmpty = await inboxStore.countPending(targetUid) === 0;

  // Sprint 41: externalize long content — letters stay tiny, full text
  // lives in per-task cache files (cacheStore). content_ref = 'cache:<kind>'.
  const taskId = task_id || store.genTaskId();
  const shaped = cacheStore.shapeContent(taskId, content, 'content');

  const task = {
    task_id: taskId,
    sender_uid: sender.uid,
    sender_name: (sender.name || '').slice(0, 64),
    sender_intro: (sender.intro || '').slice(0, 256),
    receiver_uid: targetUid,
    content: shaped.letter.slice(0, 4096),
    content_ref: shaped.ref,
    priority: priority || 'normal',
    status: ST_PENDING,
    reply_to: reply_to || null,
    message_type: message_type || 'request',
    required_capabilities: required_capabilities || [],
    matched_via: matchedVia,
    metadata: metadata || null,
    created_at: new Date().toISOString(),
  };

  await inboxStore.addPending(targetUid, task);
  _indexTask(task.task_id, targetUid);

  inboxEvents.emit('task_available', targetUid);

  const subTaskIds = [];
  if (splitTasks.length > 0) {
    for (const st of splitTasks) {
      const subTaskId = store.genTaskId();
      const subShaped = cacheStore.shapeContent(subTaskId,
        `[子任务 · 需要 ${st.capability}] ${content}`, 'content');
      const sub = {
        task_id: subTaskId,
        sender_uid: sender.uid,
        sender_name: (sender.name || '').slice(0, 64),
        sender_intro: (sender.intro || '').slice(0, 256),
        receiver_uid: st.receiver_uid,
        content: subShaped.letter.slice(0, 4096),
        content_ref: subShaped.ref,
        priority: priority || 'normal',
        status: ST_PENDING,
        reply_to: task.task_id,
        required_capabilities: [st.capability],
        matched_via: 'capability-split',
        created_at: new Date().toISOString(),
      };
      await inboxStore.addPending(st.receiver_uid, sub);
      _indexTask(sub.task_id, st.receiver_uid);
      subTaskIds.push(sub.task_id);
      inboxEvents.emit('task_available', st.receiver_uid);
    }
  }

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

// ── Sprint 37: Respond-required constraint ──────────────────────────
// Workers receiving tasks from supervisors MUST respond via respond_task.
// They cannot cancel or interrupt — only respond_task clears their inbox.

function _checkSettlementGate(task, requesterUid) {
  const sender = store.getAgent(task.sender_uid);
  const requester = store.getAgent(requesterUid);
  const senderRole = sender?.role || 'worker';
  const requesterRole = requester?.role || 'worker';

  // Gate applies: supervisor sent to non-supervisor receiver.
  if (senderRole === 'supervisor' && requesterRole !== 'supervisor'
      && task.receiver_uid === requesterUid) {
    return {
      blocked: true,
      reason: '此任务来自 PM（' + (sender?.name || task.sender_uid.slice(-8)) + '），' +
        '你作为执行者不能取消或中断。唯一的消除方式是 respond_task 提交成果，等待 PM 结算。',
    };
  }
  return { blocked: false };
}

async function cancelTask(taskId, requesterUid) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  const task = await inboxStore.getTask(ownerUid, taskId);
  if (!task) return { ok: false, error: 'task not found' };

  // Sprint 37: workers cannot cancel supervisor-assigned tasks.
  const gate = _checkSettlementGate(task, requesterUid);
  if (gate.blocked) return { ok: false, error: gate.reason };

  if (task.sender_uid !== requesterUid && requesterUid) {
    return { ok: false, error: 'only the sender can cancel this task' };
  }
  const r = await inboxStore.cancelTask(ownerUid, taskId);
  if (r.ok) { _unindexTask(taskId); setImmediate(() => ptyInjectionQueue.releaseAndDrain(ownerUid)); }
  return r;
}

async function interruptTask(taskId, requesterUid) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  const task = await inboxStore.getTask(ownerUid, taskId);
  if (!task) return { ok: false, error: 'task not found' };

  // Sprint 37: workers cannot interrupt supervisor-assigned tasks.
  const gate = _checkSettlementGate(task, requesterUid);
  if (gate.blocked) return { ok: false, error: gate.reason };

  const r = await inboxStore.interruptTask(ownerUid, taskId, true);
  if (r.ok) { setImmediate(() => ptyInjectionQueue.releaseAndDrain(ownerUid)); }
  return r;
}

async function checkInbox(uid) {
  try {  await require('./heartbeat').touch(uid);  } catch (e) { errReport.report("queue", "require", e); }

  const task = await inboxStore.claimPending(uid);
  if (!task) return null;
  await collaborationLoop.refreshState(uid);

  outboxEvents.emit('task_claimed', {
    task_id: task.task_id,
    agent_uid: uid,
    agent_name: store.getAgent(uid)?.name || '',
    sender_uid: task.sender_uid,
    priority: task.priority,
    claimed_at: new Date().toISOString(),
  });

  return _toExternal(task);
}

async function respondTask(taskId, requesterUid, result, metadata) {
  let ownerUid = _findTaskOwner(taskId);
  let task = null;

  if (ownerUid) {
    task = await inboxStore.getTask(ownerUid, taskId);
  }

  // Fallback: if index miss, scan inbox files to find the task.
  if (!task) {
    try {
      const fs = require('fs');
      const path = require('path');
      const inboxDir = inboxStore.INBOX_DIR;
      const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const uid = f.replace('.json', '');
        task = await inboxStore.getTask(uid, taskId);
        if (task) { ownerUid = uid; _indexTask(taskId, uid); break; }
      }
    } catch (e) { errReport.report("queue", "_indexTask", e); }
  }

  if (!task) return { ok: false, error: 'task not found' };
  if (task.receiver_uid !== requesterUid) {
    return { ok: false, error: 'only the assigned receiver can respond to a task' };
  }
  if (!RESPONDABLE.has(task.status)) {
    return { ok: false, error: 'task is in status "' + task.status + '" — must be pending or in_progress to respond' };
  }

  // ── Sprint 37: Worker → PM settlement gating ──────────────────────
  // When a worker responds to a supervisor's task, the task enters
  // "submitted" state — it is NOT auto-completed. The PM must review
  // and call settle_task to approve/reject before the task is settled.
  // Supervisor→worker responses (e.g. PM replying) auto-complete as before.
  // Sprint 37 Phase 6 fix: notification tasks (matched_via='notification')
  // are FYI messages from _onTaskCompleted — they auto-complete without settlement.
  const senderRole = store.getAgent(task.sender_uid)?.role || 'worker';
  const responderRole = store.getAgent(requesterUid)?.role || 'worker';
  const isNotification = task.message_type === 'notification' || task.matched_via === 'notification';
  const needsSettlement = !isNotification
    && responderRole !== 'supervisor'
    && senderRole === 'supervisor'
    && task.status !== ST_SUBMITTED;

  if (needsSettlement) {
    // Sprint 41: externalize long submission results — PM reads the full
    // text on demand via get_task_content(task_id, 'result').
    const resShaped = cacheStore.shapeContent(taskId, result || '', 'result');
    await inboxStore.updateTask(ownerUid, taskId, {
      status: ST_SUBMITTED,
      submitted_result: resShaped.letter.slice(0, 4096),
      submitted_result_ref: resShaped.ref,
      submitted_at: new Date().toISOString(),
      metadata: metadata || null,
    });

    await collaborationLoop.refreshState(requesterUid);
    _archiveReplyNotifications(requesterUid, taskId);
    setImmediate(() => ptyInjectionQueue.releaseAndDrain(requesterUid));
    outboxEvents.emit('task_submitted', {
      task_id: taskId,
      sender_uid: task.sender_uid,
      receiver_uid: task.receiver_uid,
      receiver_name: store.getAgent(requesterUid)?.name || '',
      result: result || '',
    });
    return {
      ok: true,
      status: ST_SUBMITTED,
      needs_settlement: true,
      hint: '任务已提交，等待 PM 审核结算。PM 将通过 settle_task 批准或驳回。',
    };
  }

  // ── Auto-complete (supervisor responding, or worker↔worker) ────────
  const resShaped = cacheStore.shapeContent(taskId, result || '', 'result');
  const r = await inboxStore.completeTask(ownerUid, taskId, ST_COMPLETED, resShaped.letter.slice(0, 4096));
  if (!r.ok) return r;
  _unindexTask(taskId);
  _archiveReplyNotifications(requesterUid, taskId);

  await collaborationLoop.refreshState(requesterUid);
  setImmediate(() => ptyInjectionQueue.releaseAndDrain(requesterUid));

  // Sprint 38: notification tasks are FYI — completing them must NOT
  // emit task_completed, or _onTaskCompleted will create another
  // notification task → ACK → completed → notification → ∞ loop.
  if (!isNotification) {
    outboxEvents.emit('task_completed', {
      task_id: taskId,
      sender_uid: task.sender_uid,
      receiver_uid: task.receiver_uid,
      receiver_name: store.getAgent(requesterUid)?.name || '',
      result: result || '',
      metadata: metadata || null,
    });
  }

  if (task.workflow_id || task.stage_id) {
    try {
      const wf = require('../workflowEngine');
      await wf.onStageCompleted(taskId);
    } catch (e) { errReport.report("queue", "onStageCompleted", e); }
  }
  return { ok: true };
}

// ── Sprint 37: PM settlement ──────────────────────────────────────────

// Sprint 42 (user decision): settlement notifications must not pile up.
// When a task is settled (approve/reject), archive any pending settlement
// notices referencing it from the approver's inbox — the PM's respond is
// implied by the settle itself.
function _archiveSettlementNotices(approverUid, taskId) {
  setImmediate(() => {
    try {
      const inbox = inboxStore.loadInboxSync(approverUid);
      const stale = [
        ...(inbox.pending || []).filter((t) => t.matched_via === 'settlement' && t.reply_to === taskId),
        ...(inbox.in_progress || []).filter((t) => t.matched_via === 'settlement' && t.reply_to === taskId),
      ];
      for (const t of stale) {
        inboxStore.archiveTask(approverUid, t).catch(() => {});
      }
      if (stale.length > 0) {
        console.log('[boos] settle: archived', stale.length, 'settlement notice(s) for', taskId);
      }
    } catch (e) { errReport.report('queue', 'archiveSettlementNotices', e); }
  });
}


// Sprint 42 (user decision): notifications must not pile up. After a
// respond, archive any notification-type tasks referencing the same
// original task (completion notices, FYI echoes) from the responder's
// inbox — one respond implies they were all seen.
function _archiveReplyNotifications(uid, taskId) {
  setImmediate(() => {
    try {
      const inbox = inboxStore.loadInboxSync(uid);
      const stale = [
        ...(inbox.pending || []).filter((t) => t.reply_to === taskId && t.matched_via === 'notification'),
        ...(inbox.in_progress || []).filter((t) => t.reply_to === taskId && t.matched_via === 'notification'),
      ];
      for (const t of stale) {
        inboxStore.archiveTask(uid, t).catch(() => {});
      }
      if (stale.length > 0) {
        console.log('[boos] respond: archived', stale.length, 'notification(s) for', taskId);
      }
    } catch (e) { errReport.report('queue', 'archiveReplyNotifications', e); }
  });
}

async function settleTask(taskId, approverUid, action, feedback) {
  const approver = store.getAgent(approverUid);
  if (!approver || (approver.role !== 'supervisor' && approver.role !== 'pmo')) {
    return { ok: false, error: 'only supervisor/PMO can settle tasks' };
  }

  // Sprint 38 fix: fallback scan (same as respondTask L291-303).
  // After server restart, the in-memory _taskIndex may miss tasks.
  let ownerUid = _findTaskOwner(taskId);
  let task = ownerUid ? await inboxStore.getTask(ownerUid, taskId) : null;

  if (!task) {
    try {
      const fs = require('fs');
      const ibDir = inboxStore.INBOX_DIR;
      const files = fs.existsSync(ibDir) ? fs.readdirSync(ibDir) : [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const uid = f.replace('.json', '');
        task = await inboxStore.getTask(uid, taskId);
        if (task) { ownerUid = uid; _indexTask(taskId, uid); break; }
      }
    } catch (e) { errReport.report("queue", "_indexTask", e); }
  }

  if (!task) return { ok: false, error: 'task not found in active inboxes' };
  if (task.status !== ST_SUBMITTED) {
    return { ok: false, error: 'task is in status "' + task.status + '" — must be submitted to settle' };
  }
  if (task.sender_uid !== approverUid && approver.role !== 'supervisor') {
    return { ok: false, error: 'only the task sender (or supervisor) can settle this task' };
  }

  if (action === 'approve') {
    const r = await inboxStore.completeTask(ownerUid, taskId, ST_COMPLETED,
      task.submitted_result || 'approved');
    if (!r.ok) return r;
    _unindexTask(taskId);
    setImmediate(() => ptyInjectionQueue.releaseAndDrain(ownerUid));
    _archiveSettlementNotices(approverUid, taskId);
    // Sprint 42: notification tasks are FYI — completing them must NOT
    // emit task_completed. Same guard as respondTask (L338). Without
    // this, PM approving a settlement notification cascades:
    // approve → task_completed → _onTaskCompleted → new notification
    // → worker inbox pollution.
    const isNotification = task.message_type === 'notification' || task.matched_via === 'notification';
    if (!isNotification) {
      outboxEvents.emit('task_completed', {
        task_id: taskId,
        sender_uid: task.sender_uid,
        receiver_uid: task.receiver_uid,
        receiver_name: store.getAgent(task.receiver_uid)?.name || '',
        result: task.submitted_result || '',
        settled_by: approverUid,
        settlement_feedback: feedback || '',
        // Pass notification flag so _onTaskCompleted's defense-in-depth
        // guard can skip (settle_task has no metadata arg).
        metadata: { message_type: task.message_type, matched_via: task.matched_via },
      });
    }
    return { ok: true, status: ST_COMPLETED, action: 'approved',
      hint: '任务已结算，成果已确认。' };
  }

  if (action === 'reject') {
    await inboxStore.updateTask(ownerUid, taskId, {
      status: ST_IN_PROGRESS,
      settlement_feedback: feedback || '需要修改',
      rejected_at: new Date().toISOString(),
      rejected_by: approverUid,
      retry_count: (task.retry_count || 0) + 1,
    });
    outboxEvents.emit('task_rejected_by_pm', {
      task_id: taskId,
      sender_uid: task.sender_uid,
      receiver_uid: task.receiver_uid,
      feedback: feedback || '',
    });
    _archiveSettlementNotices(approverUid, taskId);
    return { ok: true, status: ST_IN_PROGRESS, action: 'rejected',
      hint: '已驳回，worker 需根据反馈修改后重新 respond_task。' };
  }

  return { ok: false, error: 'action must be "approve" or "reject"' };
}

async function retryTask(taskId, requesterUid, isSupervisor = false) {
  // Sprint 36: supervisor can retry any task (aligns with cancel/interrupt).
  // Sprint 35 archives completed/cancelled tasks out of the inbox. Retry must
  // restore from archive when the task is no longer in an active inbox —
  // otherwise a finished task can never be retried by its sender.
  let ownerUid = _findTaskOwner(taskId);
  let task = null;
  if (ownerUid) {
    task = await inboxStore.getTask(ownerUid, taskId);
  }
  // Fallback: task is archived — scan archives to find its owner.
  if (!task) {
    try {
      const fs = require('fs');
      const path = require('path');
      const archiveDir = inboxStore.ARCHIVE_DIR;
      const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const uid = f.replace('.jsonl', '');
        const archived = await inboxStore.getArchivedTask(uid, taskId);
        if (archived) { ownerUid = uid; task = archived; break; }
      }
    } catch (e) { errReport.report("queue", "getArchivedTask", e); }
  }
  if (!task) return { ok: false, error: 'task not found' };
  if (task.sender_uid !== requesterUid && !isSupervisor) {
    return { ok: false, error: 'only the sender (or supervisor) can retry a task' };
  }
  const count = (task.retry_count || 0) + 1;
  if (count > MAX_RETRIES) {
    // Task may be in an active inbox OR already archived. completeTask only
    // handles the inbox case; for an archived task, append an exhausted record
    // directly so the archive reflects the terminal state.
    const exhausted = {
      ...task,
      status: ST_EXHAUSTED,
      result: 'Max retries (' + MAX_RETRIES + ') exceeded.',
      completed_at: new Date().toISOString(),
    };
    try {
      const inbox = await inboxStore.loadInbox(ownerUid);
      const inInbox = [...inbox.pending, ...inbox.in_progress].some((t) => t.task_id === taskId);
      if (inInbox) {
        await inboxStore.completeTask(ownerUid, taskId, ST_EXHAUSTED,
          'Max retries (' + MAX_RETRIES + ') exceeded.');
      } else {
        await inboxStore.archiveTask(ownerUid, exhausted);
      }
    } catch {
      // Best-effort — the exhaustion decision is already communicated via the return.
    }
    _unindexTask(taskId);
    return { ok: false, error: 'max retries (' + MAX_RETRIES + ') exceeded — task marked exhausted', exhausted: true };
  }
  // Move back to pending with incremented retry_count.
  task.retry_count = count;
  task.status = ST_PENDING;
  delete task.claimed_at;
  const inbox = await inboxStore.loadInbox(ownerUid);
  // Remove from in_progress
  inbox.in_progress = inbox.in_progress.filter((t) => t.task_id !== taskId);
  inbox.pending.push(task);
  await inboxStore.saveInbox(ownerUid, inbox);
  _indexTask(taskId, ownerUid);
  await collaborationLoop.refreshState(task.receiver_uid);
  setImmediate(() => ptyInjectionQueue.releaseAndDrain(task.receiver_uid));
  inboxEvents.emit('task_available', task.receiver_uid);
  return { ok: true, retry_count: count, remaining: MAX_RETRIES - count };
}

function getTask(taskId) {
  // Sprint 36: active tasks only — searches inbox (pending + in_progress).
  // Completed/archived tasks → use getArchivedTask.
  const ownerUid = _findTaskOwner(taskId);
  if (ownerUid) {
    const task = inboxStore.getTaskSync(ownerUid, taskId);
    if (task) return _toExternal(task);
  }
  // Sprint 39: fallback inbox scan — after server restart, the in-memory
  // _taskIndex may miss tasks. Scan all inbox files to find the task.
  // This mirrors the fallback in respondTask (L291-303) and settleTask (L399-410).
  try {
    const fs = require('fs');
    const inboxDir = inboxStore.INBOX_DIR;
    const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const uid = f.replace('.json', '');
      const task = inboxStore.getTaskSync(uid, taskId);
      if (task) { _indexTask(taskId, uid); return _toExternal(task); }
    }
  } catch (e) { errReport.report("queue", "_indexTask", e); }
  // Sprint 37: fallback to DAG task store — dag_tasks live in agent-bus.json,
  // not in per-agent inbox files. Without this fallback, get_task returns null
  // for all DAG task nodes.
  try {
    const dagStore = require('./dagStore');
    const dagTask = dagStore.getTask(taskId);
    if (dagTask) return dagTask;
  } catch (e) { errReport.report("queue", "getTask", e); }
  return null;
}

async function getArchivedTask(taskId) {
  // Sprint 36: search archive JSONL files for a completed/cancelled/exhausted task.
  // Scans all agent archive files. For targeted queries, prefer caller-side filtering.
  try {
    const fs = require('fs');
    const archiveDir = inboxStore.ARCHIVE_DIR;
    const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const uid = f.replace('.jsonl', '');
      const task = await inboxStore.getArchivedTask(uid, taskId);
      if (task) return _toExternal(task);
    }
    return null;
  } catch { return null; }
}

async function listMyTasks(uid) {
  const tasks = await inboxStore.listAllTasks(uid);
  return tasks.map(_toExternal);
}

// Sprint 36: supervisor view — aggregate inbox files from all agents in a workspace.
// Only returns active tasks (pending + in_progress). Historical tasks stay in archive.
async function listAllTasksInWorkspace(workspace) {
  const registry = require('./registry');
  const errReport = require("../errorReport");
  const agents = registry.listAgentsInWorkspace(workspace);
  const all = [];
  for (const agent of agents) {
    try {
      const tasks = await inboxStore.listAllTasks(agent.uid);
      all.push(...tasks.map(_toExternal));
    } catch (e) { errReport.report("queue", "push", e); }
  }
  all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return all;
}

function listAllPendingQueues() {
  const result = [];
  for (const [taskId, uid] of _taskIndex) {
    const task = inboxStore.getTaskSync(uid, taskId);
    if (task) result.push({ uid, task_id: taskId, status: task.status, priority: task.priority });
  }
  return result;
}

async function hasPendingTasks(uid) {
  return await inboxStore.countPending(uid) > 0;
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

// ── supervisor privilege operations ─────────────────────────────────────

async function supervisorCancelTask(taskId) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  const r = await inboxStore.cancelTask(ownerUid, taskId);
  if (r.ok) _unindexTask(taskId);
  return r;
}

async function supervisorInterruptTask(taskId) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  return inboxStore.interruptTask(ownerUid, taskId, true);
}

async function cancelAllTasksForAgent(uid) {
  const inbox = await inboxStore.loadInbox(uid);
  let count = 0;
  for (const t of [...inbox.pending, ...inbox.in_progress]) {
    await inboxStore.cancelTask(uid, t.task_id);
    _unindexTask(t.task_id);
    count++;
  }
  return count;
}

// ── task blocking ───────────────────────────────────────────────────────

async function blockTask(taskId, reason) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  const task = await inboxStore.getTask(ownerUid, taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!BLOCKABLE.has(task.status)) {
    return { ok: false, error: 'cannot block task in status "' + task.status + '" — only in_progress tasks can be blocked' };
  }
  // Move from in_progress to pending with a block marker.
  const inbox = await inboxStore.loadInbox(ownerUid);
  inbox.in_progress = inbox.in_progress.filter((t) => t.task_id !== taskId);
  task.status = ST_BLOCKED;
  task.block_reason = reason || 'blocked on decision';
  inbox.pending.push(task); // stays visible but blocked
  await inboxStore.saveInbox(ownerUid, inbox);
  await collaborationLoop.refreshState(task.receiver_uid);
  setImmediate(() => ptyInjectionQueue.releaseAndDrain(task.receiver_uid));
  return { ok: true };
}

async function unblockTask(taskId) {
  const ownerUid = _findTaskOwner(taskId);
  if (!ownerUid) return { ok: false, error: 'task not found' };
  const task = await inboxStore.getTask(ownerUid, taskId);
  if (!task) return { ok: false, error: 'task not found' };
  if (!UNBLOCKABLE.has(task.status)) {
    return { ok: false, error: 'cannot unblock task in status "' + task.status + '" — only blocked tasks can be unblocked' };
  }
  const inbox = await inboxStore.loadInbox(ownerUid);
  inbox.pending = inbox.pending.filter((t) => t.task_id !== taskId);
  task.status = ST_IN_PROGRESS;
  delete task.block_reason;
  inbox.in_progress.push(task);
  await inboxStore.saveInbox(ownerUid, inbox);
  await collaborationLoop.refreshState(task.receiver_uid);
  inboxEvents.emit('task_available', task.receiver_uid);
  return { ok: true };
}

// ── helpers ─────────────────────────────────────────────────────────────

async function _matchByCapability(agents, requiredCaps, senderUid) {
  if (requiredCaps && requiredCaps.length > 0) {
    return await collaborationLoop.findBestAgent(agents, requiredCaps, senderUid);
  }
  return null;
}

function _findSupervisor(agents) {
  const sup = agents.find((a) => a.role === 'supervisor');
  return sup ? sup.uid : null;
}

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
    content_ref: task.content_ref || null,   // Sprint 41: 'cache:<kind>' when externalized
    priority: task.priority,
    status: task.status,
    result: task.result,
    submitted_result_ref: task.submitted_result_ref || null,
    workflow_id: task.workflow_id || null,
    stage_id: task.stage_id || null,
    reply_to: task.reply_to || null,
    required_capabilities: task.required_capabilities || [],
    matched_via: task.matched_via || 'direct',
    metadata: task.metadata || null,
    created_at: task.created_at,
    updated_at: task.updated_at || task.claimed_at,
  };
}

module.exports = {
  sendTask, cancelTask, interruptTask, checkInbox, respondTask, settleTask, retryTask,
  blockTask, unblockTask,
  getTask, getArchivedTask, listMyTasks, listAllTasksInWorkspace, listAllPendingQueues, hasPendingTasks, broadcast,
  inboxEvents, outboxEvents,
  supervisorCancelTask, supervisorInterruptTask, cancelAllTasksForAgent,
  rebuildTaskIndex, _findTaskOwner,
  ST_PENDING, ST_IN_PROGRESS, ST_COMPLETED, ST_CANCELLED, ST_INTERRUPTED, ST_EXHAUSTED, ST_BLOCKED, ST_SUBMITTED,
  MAX_RETRIES,
};

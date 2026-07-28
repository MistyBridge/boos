// Wake-agent subsystem + PTY injection + task timeout + TeamCompact.
//
// Extracted from notifications.js (Sprint 31 refactor — ≤500 lines).
// Manages: wakeAgent(), PTY command injection, per-task timeout tracking,
// and milestone-triggered /compact for all workers.

'use strict';

const store = require('./store');
const persistedSessions = require('../persistedSessions');
const webTerminal = require('../webTerminal');

// ── frontend notify reference (set by notifications.js) ────────────────
let _frontendNotify = null;
function setFrontendNotify(fn) { _frontendNotify = fn; }

// ── delivery tracking ──────────────────────────────────────────────────
const _lastWake = new Map();
const _sendFailures = new Map();
const _wakeAttempts = new Map();
const MAX_SEND_FAILURES = 3;
const MAX_WAKE_ATTEMPTS = 3;

// ── PTY injection ──────────────────────────────────────────────────────
// Two-phase: write command text, then after delay write CR (Enter).
// Splitting the submit from the text is what makes auto-submit reliable.

const WAKE_COMMAND = 'check_inbox';
const PTY_SUBMIT_DELAY_MS = parseInt(process.env.BOOS_PTY_SUBMIT_DELAY_MS, 10) || 120;

function _writeToPty(sessionId, data) {
  try { webTerminal.write(sessionId, data); }
  catch (e) { console.warn('[boos] notifications: PTY write failed for session', sessionId, e.message); }
}

async function _injectCommand(sessionId, command) {
  _writeToPty(sessionId, command);
  await new Promise((r) => setTimeout(r, PTY_SUBMIT_DELAY_MS));
  _writeToPty(sessionId, '\r');
}

// ── session lookup ─────────────────────────────────────────────────────

async function _findSessionByUid(uid) {
  const all = await persistedSessions.loadAll();
  const match = all.find((s) => s.agentUid === uid && s.status === 'running');
  if (match) {
    const term = webTerminal.get(match.id);
    if (term && !term.exitedAt) return match;
  }
  return null;
}

function _logDeliveryFailure(uid, agentName, reason) {
  console.log('[boos] notifications: outbound delivery failed for', agentName, '(' + uid + '):', reason);
}

// ── wake agent (SSE + PTY dual-channel) ─────────────────────────────────

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const urgency = opts.urgency || 'normal';
  const tasksToDeliver = store.listActiveTasks(uid);

  console.log('[boos] wakeAgent: attempting to wake', agent.name, '(', uid, ') with', tasksToDeliver.length, 'tasks');

  // SSE primary delivery path — reaches agent through MCP SSE connection.
  let sseDelivered = false;
  try {
    const { notifyAgent } = require('./transport');
    sseDelivered = notifyAgent(uid, 'notifications/agent_bus/wake', {
      uid, agent_name: agent.name, workspace: agent.workspace,
      pending: tasksToDeliver.length,
      task_ids: tasksToDeliver.map((t) => t.task_id),
      urgency,
      sender_name: opts.sender_name || null,
      sender_uid: opts.sender_uid || null,
      message: (opts.message || '').slice(0, 256),
      timestamp: new Date().toISOString(),
    });
  } catch (e) { console.warn('[boos] wakeAgent: SSE notify failed for', agent.name, e.message); }

  // PTY injection fallback — types check_inbox + Enter into the terminal.
  let ptyWritten = false;
  const match = await _findSessionByUid(uid);
  if (match) {
    const term = webTerminal.get(match.id);
    if (term && !term.exitedAt) {
      try {
        await _injectCommand(match.id, WAKE_COMMAND);
        ptyWritten = true;
        console.log('[boos] wakeAgent: PTY submit injected to', agent.name,
          '(' + tasksToDeliver.length, 'pending tasks)');
      } catch (e) {
        console.warn('[boos] wakeAgent: PTY injection failed for', agent.name, e.message);
      }
    }
  }

  if (!sseDelivered && !ptyWritten) {
    _logDeliveryFailure(uid, agent.name, 'neither SSE nor PTY available');
    return { ok: false, error: 'delivery failed: agent has no active SSE or PTY connection' };
  }

  _lastWake.set(uid, Date.now());
  _wakeAttempts.delete(uid);
  _sendFailures.delete(uid);

  if (_frontendNotify && match) {
    try { _frontendNotify(match.id, 'busy', { uid, name: agent.name, pending: tasksToDeliver.length }); } catch {}
  }

  console.log('[boos] wakeAgent: successfully woke', agent.name,
    `(SSE:${sseDelivered} PTY:${ptyWritten}) with`, tasksToDeliver.length, 'tasks');

  return {
    ok: true, agent_uid: uid, agent_name: agent.name, boos_session_id: match?.id || null,
    urgency, tasks_delivered: tasksToDeliver.length,
    task_ids: tasksToDeliver.map((t) => t.task_id),
    sse_delivered: sseDelivered, pty_delivered: ptyWritten,
  };
}

// ── task timeout + retry ────────────────────────────────────────────────
// When a task is sent, a timeout is scheduled. If the task is still pending
// after TASK_TIMEOUT_MS, wake_agent is retried. After max retries, the task
// is escalated to root/PM inbox via send_to_root.

const TASK_TIMEOUT_MS = parseInt(process.env.BOOS_TASK_TIMEOUT_MS, 10) || 86_400_000;
const TASK_MAX_RETRIES = parseInt(process.env.BOOS_TASK_MAX_RETRIES, 10) || 0;
const _taskTimeouts = new Map(); // task_id → { timer, task_id, receiver_uid, retry_count }

function _cancelTaskTimeout(taskId) {
  const entry = _taskTimeouts.get(taskId);
  if (entry) { clearTimeout(entry.timer); _taskTimeouts.delete(taskId); }
}

function onTaskClaimed(taskId) { _cancelTaskTimeout(taskId); }

function cancelTaskTimeoutTracking(taskId) { _cancelTaskTimeout(taskId); }

function _scheduleTaskTimeout(taskId, receiverUid, retryCount) {
  _cancelTaskTimeout(taskId);

  const timer = setTimeout(async () => {
    _taskTimeouts.delete(taskId);
    try {
      const task = store.getTask(taskId);
      if (!task) return;
      if (!['pending', 'blocked'].includes(task.status)) return;

      const agent = store.getAgent(receiverUid);
      const agentName = agent?.name || '(unknown)';

      console.log('[boos] task-timeout:', taskId, 'still pending after retry', retryCount, '/', TASK_MAX_RETRIES);

      if (retryCount < TASK_MAX_RETRIES) {
        await wakeAgent(receiverUid, { urgency: 'urgent' });
        _scheduleTaskTimeout(taskId, receiverUid, retryCount + 1);
      } else {
        // Escalate: cancel task, notify root/PM.
        await store.cancelTaskAtomic(taskId, null, { supervisor: true });
        try {
          const senderName = task.sender_name || (store.getAgent(task.sender_uid)?.name || '系统');
          const escalatedContent = [
            '## 任务超时升级 — 接收方无响应',
            `- **原任务**: ${taskId}`,
            `- **发件人**: ${senderName} (${task.sender_uid})`,
            `- **收件人**: ${agentName} (${receiverUid})`,
            `- **内容摘要**: ${(task.content || '').slice(0, 200)}`,
            `- **重试次数**: ${TASK_MAX_RETRIES}`,
            `- **超时阈值**: ${TASK_TIMEOUT_MS / 1000}s`,
            '',
            '原任务已自动取消。请 PM/root 决定:',
            '- `retry_task` 重新派发',
            '- `wake_agent` 手动唤醒接收方',
            '- 重新 `send_task` 给其他 agent',
          ].join('\n');

          await store.insertTask({
            task_id: store.genTaskId(),
            sender_uid: 'system',
            sender_name: 'BOOS Timeout',
            sender_intro: '任务超时自动升级',
            receiver_uid: store.ROOT_UID,
            content: escalatedContent,
            priority: 'high',
            status: 'pending',
            reply_to: taskId,
            required_capabilities: [],
            matched_via: 'timeout_escalation',
            created_at: new Date().toISOString(),
          });
        } catch (e) { console.warn('[boos] task-timeout: escalation failed:', e.message); }
      }
    } catch (e) { console.warn('[boos] task-timeout: error in timeout handler for', taskId, e.message); }
  }, TASK_TIMEOUT_MS);
  timer.unref();
  _taskTimeouts.set(taskId, { timer, task_id: taskId, receiver_uid: receiverUid, retry_count: retryCount });
}

// ── TeamCompact (Sprint 24) ─────────────────────────────────────────────

const COMPACT_COMMAND = '/compact';

async function compactAllWorkers(workspace, { milestone, note } = {}) {
  const allAgents = store.listAllAgents();
  const workers = allAgents.filter((a) =>
    a.workspace === workspace && a.role !== 'supervisor' && a.uid
  );
  if (workers.length === 0) {
    return { ok: false, error: 'no worker agents found in workspace ' + workspace };
  }

  // Gate: verify all workers idle.
  const busyWorkers = [];
  for (const w of workers) {
    const active = store.listActiveTasks(w.uid);
    if (active.some((t) => t.status === 'in_progress')) {
      busyWorkers.push({ uid: w.uid, name: w.name, active: active.filter((t) => t.status === 'in_progress').length });
    }
  }
  if (busyWorkers.length > 0) {
    return { ok: false, error: 'agents still busy', busy: busyWorkers.map((b) => b.name + ' (' + b.active + ' tasks)') };
  }

  const results = [];
  for (const w of workers) {
    const match = await _findSessionByUid(w.uid);
    if (!match) { results.push({ uid: w.uid, name: w.name, compacted: false, error: 'no PTY session' }); continue; }
    const term = webTerminal.get(match.id);
    if (!term || term.exitedAt) { results.push({ uid: w.uid, name: w.name, compacted: false, error: 'PTY exited' }); continue; }
    try {
      await _injectCommand(match.id, COMPACT_COMMAND);
      results.push({ uid: w.uid, name: w.name, compacted: true, boos_session_id: match.id });
      console.log('[boos] TeamCompact: /compact injected to', w.name);
    } catch (e) {
      results.push({ uid: w.uid, name: w.name, compacted: false, error: e.message });
    }
  }

  const compacted = results.filter((r) => r.compacted).length;
  return {
    ok: true, compacted, total: workers.length,
    milestone: milestone || null, note: note || null, agents: results,
    hint: compacted === workers.length
      ? 'All ' + compacted + ' agents compacted.'
      : compacted + '/' + workers.length + ' agents compacted (' + results.filter((r) => !r.compacted).length + ' failures).',
  };
}

module.exports = {
  wakeAgent, compactAllWorkers,
  setFrontendNotify,
  _findSessionByUid, _writeToPty, _injectCommand,
  _logDeliveryFailure,
  _lastWake, _sendFailures, _wakeAttempts,
  MAX_SEND_FAILURES, MAX_WAKE_ATTEMPTS,
  onTaskClaimed, cancelTaskTimeoutTracking, _scheduleTaskTimeout, _cancelTaskTimeout,
};

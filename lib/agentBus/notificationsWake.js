// Wake-agent subsystem + PTY injection + task timeout + TeamCompact.
//
// Extracted from notifications.js (Sprint 31 refactor — ≤500 lines).
// Manages: wakeAgent(), SS+PTY dual-channel wake, per-task timeout tracking,
// and milestone-triggered /compact for all workers.
//
// Sprint 38: Fixed PTY injection — changed from two-phase (write text →
// delay → write \r) to single-shot (write command + \n). Claude Code's
// Ink TUI does not process a trailing \r written in a separate pty.write()
// call as "submit"; appending \n in the same write triggers the submit.
//
// Sprint N: PTY injection routed through per-agent queue (ptyInjectionQueue.js).
// All writes go through enqueue(); injection is gated on agent idle state
// and drained one-by-one via event-driven busy→idle hooks.

'use strict';

const store = require('./store');
const inboxStore = require('./inboxStore');
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
// Sprint 38 v3: Plain \r burst injection is the default — `command + \r`
// written in a single pty.write() call. This IS feasible and works with
// Claude Code's Ink TUI. The problem was the \x1b[200~...\x1b[201~
// bracketed-paste wrapper — Ink does NOT process these escape sequences.
//
// Modes (BOOS_PTY_INJECT_MODE env):
//   burst  — all chars in one write, \r-terminated (DEFAULT ✓)
//   typed  — char-by-char with BOOS_PTY_CHAR_DELAY_MS (slower, for debug)
//   paste  — bracketed-paste \x1b[200~...\x1b[201~ (broken in Ink ✗)

const WAKE_COMMAND = 'check_inbox[BOOS]';  // fallback when no task context
const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';
const CHAR_DELAY_MS = parseInt(process.env.BOOS_PTY_CHAR_DELAY_MS, 10) || 8;

function _buildWakeCommand(taskIds) {
  // Sprint 38 fix: Always use bare check_inbox[BOOS] — never append task IDs.
  // check_inbox MCP tool has properties:{} (no args). Appending ', task_xxx'
  // produces invalid tool-call syntax that Claude Code silently ignores.
  // The task context is already in the agent's FIFO inbox — check_inbox pops it.
  return WAKE_COMMAND;
}

function _writeToPty(sessionId, data) {
  try { webTerminal.write(sessionId, data); }
  catch (e) { console.warn('[boos] notifications: PTY write failed for session', sessionId, e.message); }
}

// Character-by-character injection (opt-in via BOOS_PTY_INJECT_MODE=typed).
function _typedInject(sessionId, text, delayMs) {
  let i = 0;
  const len = text.length;
  function next() {
    if (i >= len) return;
    _writeToPty(sessionId, text[i]);
    i++;
    if (i < len) setTimeout(next, delayMs);
  }
  next();
}

function _injectCommand(sessionId, command) {
  const mode = process.env.BOOS_PTY_INJECT_MODE || 'burst';
  const fullText = command + '\r';

  switch (mode) {
    case 'typed':
      _typedInject(sessionId, fullText, CHAR_DELAY_MS);
      break;
    case 'paste':
      _writeToPty(sessionId, PASTE_START + fullText + PASTE_END);
      break;
    case 'burst':
    default:
      _writeToPty(sessionId, fullText);
      break;
  }
}

// ── session lookup ─────────────────────────────────────────────────────
// Sprint 33: When uid === BOOS session ID (new system), lookup is O(1) —
// just check webTerminal.get(uid). For legacy agent_xxx UIDs, fall back
// to the multi-path identity card resolution.

async function _findSessionByUid(uid) {
  const session = await persistedSessions.findByCliSessionId(uid);
  if (session && session.status === 'running') {
    const t = webTerminal.get(session.id);
    if (t && !t.exitedAt) return session;
  }
  if (session) return null;
  const all = await persistedSessions.loadAll();
  const byAgent = all.find((s) => s.agentUid === uid && s.status === 'running' && !s.deletedAt);
  if (byAgent) {
    const t = webTerminal.get(byAgent.id);
    if (t && !t.exitedAt) return byAgent;
  }
  return null;
}

async function _findAnySessionByUid(uid) {
  const session = await persistedSessions.findByCliSessionId(uid);
  if (session) return session;
  const all = await persistedSessions.loadAll();
  return all.find((s) => s.agentUid === uid && !s.deletedAt) || null;
}

async function _autoResumeSession(uid) {
  const session = await _findAnySessionByUid(uid);
  if (!session) return null;
  if (session.status === 'running') {
    const term = webTerminal.get(session.id);
    if (term && !term.exitedAt) return session;
  }
  try {
    const spawnFn = require('../sessionHelpers').getSpawnSessionRecord();
    if (!spawnFn) { console.warn('[boos] auto-resume: spawnSessionRecord bridge not set'); return null; }
    const { loadConfig } = require('../config');
    const cfg = await loadConfig();
    const cli = (cfg.clis || []).find((c) => c.id === session.cliId);
    if (!cli) { console.warn('[boos] auto-resume: CLI not found for', session.cliId); return null; }
    console.log('[boos] auto-resume: starting', session.id.slice(-8), 'for agent', uid.slice(-8));
    await spawnFn({ record: session, cli, cfg, body: {}, resume: true });
    await new Promise((r) => setTimeout(r, 1500));
    const term = webTerminal.get(session.id);
    if (term && !term.exitedAt) {
      console.log('[boos] auto-resume: PTY ready for', session.id.slice(-8));
      return session;
    }
    return null;
  } catch (e) {
    console.warn('[boos] auto-resume: failed for', uid.slice(-8), e.message);
    return null;
  }
}

function _logDeliveryFailure(uid, agentName, reason) {
  console.log('[boos] notifications: outbound delivery failed for', agentName, '(' + uid + '):', reason);
}

// ── wake agent (SSE + PTY dual-channel) ─────────────────────────────────

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const urgency = opts.urgency || 'normal';
  const inbox = inboxStore.loadInboxSync(uid);
  const tasksToDeliver = [...inbox.pending, ...inbox.in_progress];

  console.log('[boos] wakeAgent: attempting to wake', agent.name, '(', uid, ') with', tasksToDeliver.length, 'tasks');

  // SSE notification — best-effort.
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

  // PTY — routed through per-agent injection queue (event-driven, flow-controlled).
  // enqueue() → drainIfIdle() gates on agent idle state; busy agents receive
  // injection when the next busy→idle transition fires releaseAndDrain().
  let ptyWritten = false;
  const cmd = _buildWakeCommand(tasksToDeliver.map((t) => t.task_id));
  try {
    const ptyQueue = require('./ptyInjectionQueue');
    const enqResult = await ptyQueue.enqueue(uid, cmd);
    ptyWritten = enqResult.queued || false;
    if (enqResult.queue_length > 1) {
      console.log('[boos] wakeAgent: PTY injection queued for', agent.name,
        '(busy —', enqResult.queue_length, 'in queue)');
    }
  } catch (e) {
    console.warn('[boos] wakeAgent: PTY queue enqueue failed for', agent.name, e.message);
  }

  // Resolve session for status reporting / frontend notification.
  let match = await _findSessionByUid(uid);
  if (!match && !ptyWritten) {
    console.log('[boos] wakeAgent:', agent.name, 'has no live PTY session — attempting auto-resume');
    match = await _autoResumeSession(uid);
  }

  if (!sseDelivered && !ptyWritten) {
    _logDeliveryFailure(uid, agent.name, 'neither SSE nor PTY available');
    return { ok: false, error: 'delivery failed: agent has no active connection' };
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
    ok: true, agent_uid: uid, agent_name: agent.name, session_id: match?.id || null,
    urgency, tasks_delivered: tasksToDeliver.length,
    task_ids: tasksToDeliver.map((t) => t.task_id),
    sse_delivered: sseDelivered, pty_delivered: ptyWritten,
  };
}

// ── task timeout + retry ────────────────────────────────────────────────

const TASK_TIMEOUT_MS = parseInt(process.env.BOOS_TASK_TIMEOUT_MS, 10) || 86_400_000;
const TASK_MAX_RETRIES = parseInt(process.env.BOOS_TASK_MAX_RETRIES, 10) || 0;
const _taskTimeouts = new Map();

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

  // Route through injection queue (shared gate + event-driven drain).
  const ptyQueue = require('./ptyInjectionQueue');
  const results = [];
  for (const w of workers) {
    try {
      const enqResult = await ptyQueue.enqueue(w.uid, COMPACT_COMMAND);
      results.push({
        uid: w.uid, name: w.name,
        compacted: enqResult.queued || false,
        queued: enqResult.queue_length > 1,
      });
      console.log('[boos] TeamCompact: /compact enqueued for', w.name);
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
  _findSessionByUid, _findAnySessionByUid, _autoResumeSession,
  _writeToPty, _injectCommand,
  _logDeliveryFailure,
  _lastWake, _sendFailures, _wakeAttempts,
  MAX_SEND_FAILURES, MAX_WAKE_ATTEMPTS,
  onTaskClaimed, cancelTaskTimeoutTracking, _scheduleTaskTimeout, _cancelTaskTimeout,
};

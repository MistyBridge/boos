// BOOS → Agent-Bus in-process push notification bridge.
//
// Event-driven architecture: send_task → inboxEvents('task_available') →
// mark in_progress → SSE notifyAgent(). Agent calls check_inbox() →
// processes → respond_task → outboxEvents('task_completed') → SSE push.
//
// Split across 2 modules (Sprint 31 — ≤500 lines each):
//   notifications.js     — event routing + HR agent + frontend bridge (this file)
//   notificationsWake.js — wake agent + PTY injection + task timeout + compact
//
// Sprint N: All PTY writes routed through ptyInjectionQueue.enqueue().

'use strict';

const path = require('path');
const queue = require('./queue');
const store = require('./store');
const inboxStore = require('./inboxStore');
const registry = require('./registry');
const collaborationLoop = require('./collaborationLoop');
const taskAnalytics = require('./taskAnalytics');
const hrAgent = require('../hrAgent');
const taskTimeout = require('./taskTimeout');
const persistedSessions = require('../persistedSessions');
const webTerminal = require('../webTerminal');
const wakeMod = require('./notificationsWake');
const autoSupervisor = require('./autoSupervisor');
const ptyInjectionQueue = require('./ptyInjectionQueue');

// ── Frontend activity bridge ──────────────────────────────────────────
let _frontendNotify = null;
function setFrontendNotify(fn) {
  _frontendNotify = fn;
  wakeMod.setFrontendNotify(fn);
}

let _hrAgentUid = null;
let _staleTimer = null;

const DEBOUNCE_MS = 1000;
let _started = false;
const _pendingQueues = new Set();

async function start(workspace) {
  if (_started) return;
  _started = true;

  queue.inboxEvents.on('task_available', _onTaskAvailable);
  queue.outboxEvents.on('task_completed', _onTaskCompleted);
  queue.outboxEvents.on('task_claimed', _onTaskClaimed);
  queue.outboxEvents.on('task_submitted', _onTaskSubmitted);
  queue.outboxEvents.on('task_rejected_by_pm', _onTaskRejectedByPM);

  const ws = workspace || 'boos';

  // Run all 3 agent registrations in PARALLEL — they're independent.
  // This cuts startup time from ~3× worst-case to ~1× worst-case.
  const results = await Promise.allSettled([
    // 1. Generalist catch-all agent.
    collaborationLoop.ensureGeneralistAgent(registry, ws).then((uid) => {
      if (uid) console.log('[boos] collaboration loop: generalist agent ready (workspace=' + ws + ')');
    }),
    // 2. Root Agent — permanent human↔agent communication bridge.
    registry.registerRootAgent({
      name: 'BOOS Root',
      intro: 'BOOS 系统根代理 — 人类与 Agent 之间的通信桥梁。Agent 发送任务到此代理即表示请求人类关注或决策。',
    }).then((rootResult) => {
      console.log('[boos] root agent registered:', rootResult.uid, rootResult.reconnected ? '(reconnected)' : '(new)');
    }),
    // 3. HR Agent — auto-register and handle recruitment requests.
    registry.registerAgent({
      name: 'HR Agent',
      intro: 'BOOS 内嵌 HR Agent — 自动角色招募系统。',
      workspace: ws, role: 'worker', capabilities: ['recruitment', 'hr'],
    }).then((hrResult) => {
      _hrAgentUid = hrResult.uid;
      console.log('[boos] HR Agent registered:', _hrAgentUid);
      queue.inboxEvents.on('task_available', async (uid) => {
        if (uid !== _hrAgentUid) return;
        await _handleHrTask();
      });
    }),
  ]);

  // Log failures.
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn('[boos] agent-bus init: agent registration failed:', r.reason?.message || r.reason);
    }
  }

  // Recruitment suggestions → supervisor's PTY (routed through injection queue).
  taskAnalytics.analyticsEvents.on('recruitment_suggested', async (suggestion) => {
    try {
      const supervisors = store.listAgentsInWorkspace(ws).filter((a) => a.role === 'supervisor');
      for (const sup of supervisors) {
        const capName = require('../hrAgent').getCapabilityName(suggestion.capability) || suggestion.capability;
        const msg = `[agent-bus] 📊 任务分析: 过去1小时有 ${suggestion.count} 个 "${capName}" 类任务。是否通过 HR Agent 招募${capName}？`;
        ptyInjectionQueue.enqueue(sup.uid, msg).catch(() => {});
      }
    } catch {}
  });

  // 24h timeout → archive + PTY notification (routed through injection queue).
  taskTimeout.start(store, async (task) => {
    try {
      const senderAg = store.getAgent(task.sender_uid);
      if (senderAg) {
        const msg = '[agent-bus] ⏰ 任务超时 #' + task.task_id + ': 超过24h已归档';
        ptyInjectionQueue.enqueue(task.sender_uid, msg).catch(() => {});
      }
    } catch {}
  });

  // Heartbeat + crash recovery scanner.
  try {
    const heartbeat = require('./heartbeat');
    heartbeat.start(store, {
      workspace,
      onUnresponsive(uid, name, reassigned) {
        console.log('[boos] heartbeat: agent', name, 'unresponsive —', reassigned, 'tasks reassigned');
      },
    });
  } catch (e) { console.warn('[boos] heartbeat init failed:', e.message); }

  // Sprint 36: DAG task timeout scanner (every 2min, escalates stuck tasks > 24h).
  try {
    const dagTimeout = require('./dagTimeout');
    dagTimeout.start((task) => {
      console.log('[boos] dagTimeout: escalated', task.task_id, task.title || '');
    });
  } catch (e) { console.warn('[boos] dagTimeout init failed:', e.message); }

  // ── Sprint 37: Decision area unread count SSE ────────────────────────
  // Listens for decision changes and pushes unread_count to frontend watchers.
  try {
    const decisionSystem = require('../decisionSystem');
    if (decisionSystem.decisionsEvents) {
      decisionSystem.decisionsEvents.on('changed', ({ event }) => {
        try {
          const { notifyAgent } = require('./transport');
          const { ROOT_UID } = store;
          if (ROOT_UID) {
            notifyAgent(ROOT_UID, 'notifications/agent_bus/unread_count', {
              event,
              source: 'decisions',
              timestamp: new Date().toISOString(),
            });
          }
          if (_frontendNotify) {
            _frontendNotify('__root__', 'idle', {
              type: 'unread_count_changed',
              source: 'decisions',
              event,
              timestamp: new Date().toISOString(),
            });
          }
        } catch {}
      });
    }
  } catch (e) { console.warn('[boos] decisionsEvents listener init failed:', e.message); }

  // ── Sprint 37: Goal SSE notification — path verification ────────────
  // Goal lifecycle events flow through existing channels:
  //   goal_create → feedbackManager.sendFeedback → queue.sendTask →
  //   inboxEvents('task_available') → SSE via transport.js (L154-161).
  // PM wake is already handled by feedbackManager (L88-101).
  // ROOT notifications via feedbackManager.notifyUser → queue.sendTask → ROOT inbox.
  // No additional SSE channel needed — task_available covers goal dispatch.

  // Stale in_progress task reclaimer (every 60s, returns to pending after 120s).
  // Sprint 35: scans per-agent inbox files instead of the shared agent-bus.json.
  _staleTimer = setInterval(async () => {
    try {
      const fs = require('fs');
      const path = require('path');
      const inboxDir = require('./inboxStore').INBOX_DIR;
      const now = Date.now();
      let n = 0;
      let files;
      try { files = fs.readdirSync(inboxDir); } catch { return; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const uid = f.replace('.json', '');
        try {
          const inbox = require('./inboxStore').loadInboxSync(uid);
          let changed = false;
          for (let i = inbox.in_progress.length - 1; i >= 0; i--) {
            const t = inbox.in_progress[i];
            // Sprint 37: skip submitted tasks — they are waiting for PM settlement,
            // not stuck in execution. Reclaiming them would spam the worker with
            // the same task every 60s while the PM reviews.
            if (t.status === 'submitted') continue;
            const updated = t.claimed_at || t.created_at;
            if (now - new Date(updated).getTime() < 120_000) continue;
            // Move back to pending.
            t.status = 'pending';
            delete t.claimed_at;
            inbox.pending.push(t);
            inbox.in_progress.splice(i, 1);
            n++;
            changed = true;
            setImmediate(() => queue.inboxEvents.emit('task_available', uid));
          }
          if (changed) {
            await inboxStore.saveInbox(uid, inbox);
            // Agent may now be idle — drain the PTY injection queue.
            ptyInjectionQueue.releaseAndDrain(uid).catch(() => {});
          }
        } catch {}
      }
      if (n > 0) console.log('[boos] stale-reclaim:', n, 'tasks in_progress→pending');
    } catch {}
  }, 60_000);
  _staleTimer.unref();

  // Auto-Supervisor: code-layer background loop that detects stalled projects.
  try { autoSupervisor.start(); } catch (e) { console.warn('[boos] auto-supervisor start failed:', e.message); }

  console.log('[boos] agent-bus push notifications active (in+out, zero-polling)');
}

function stop() {
  if (!_started) return;
  _started = false;
  try { require('./heartbeat').stop(); } catch {}
  if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
  try { autoSupervisor.stop(); } catch {}
  try { ptyInjectionQueue.cancelAll(); } catch {}
  queue.inboxEvents.removeListener('task_available', _onTaskAvailable);
  queue.outboxEvents.removeListener('task_completed', _onTaskCompleted);
  queue.outboxEvents.removeListener('task_claimed', _onTaskClaimed);
  queue.outboxEvents.removeListener('task_submitted', _onTaskSubmitted);
  queue.outboxEvents.removeListener('task_rejected_by_pm', _onTaskRejectedByPM);
}

// ── Inbound: task available → wake + notify ────────────────────────────

async function _onTaskAvailable(uid) {
  const ROOT_UID = store.ROOT_UID;
  if (uid === ROOT_UID) { await _onRootAgentTask(); return; }

  const last = wakeMod._lastWake.get(uid) || 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  wakeMod._lastWake.set(uid, Date.now());

  const agent = store.getAgent(uid);
  if (!agent) return;

  // Identity card lookup → wake-before-deliver.
  let match = await wakeMod._findSessionByUid(uid);
  if (!match) {
    if (agent.role === 'supervisor') {
      console.log('[boos] _onTaskAvailable: agent', agent.name, 'has no bound session — SSE-only delivery');
    }
  }

  // Supervisor without bound session: SSE-only delivery.
  if (!match) {
    const tasks = store.listPendingTasks(uid);
    if (tasks.length > 0) {
      _pendingQueues.add(uid);
      try {
        const { notifyAgent } = require('./transport');
        notifyAgent(uid, 'notifications/agent_bus/inbox_updated', {
          uid, agent_name: agent.name, workspace: agent.workspace,
          pending: tasks.length, task_ids: tasks.map((t) => t.task_id),
        });
      } catch {}
      for (const t of tasks) { wakeMod._scheduleTaskTimeout(t.task_id, uid, 0); }
    }
    return;
  }

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) {
    wakeMod._logDeliveryFailure(uid, agent.name, 'PTY not available');
    return;
  }

  const tasks = store.listPendingTasks(uid);
  if (tasks.length === 0) { _pendingQueues.delete(uid); return; }
  _pendingQueues.add(uid);

  try {
    // SSE transport notification.
    try {
      const { notifyAgent } = require('./transport');
      notifyAgent(uid, 'notifications/agent_bus/inbox_updated', {
        uid, agent_name: agent.name, workspace: agent.workspace,
        pending: tasks.length, task_ids: tasks.map((t) => t.task_id),
      });
    } catch {}

    // Frontend SSE — task lifecycle events.
    if (_frontendNotify) {
      for (const t of tasks) {
        try {
          _frontendNotify(match.id, 'busy', {
            type: 'task_lifecycle', event: 'task_available',
            task_id: t.task_id, receiver_uid: uid,
            sender_name: t.sender_name || (store.getAgent(t.sender_uid)?.name || ''),
            sender_uid: t.sender_uid, priority: t.priority,
            content_preview: (t.content || '').slice(0, 100), created_at: t.created_at,
          });
        } catch {}
      }
      try { _frontendNotify(match.id, 'busy', { uid, name: agent.name, pending: tasks.length }); } catch {}
    }

    wakeMod._sendFailures.delete(uid);

    for (const t of tasks) { wakeMod._scheduleTaskTimeout(t.task_id, uid, 0); }

    // Trigger PTY wake (routed through injection queue).
    const wakeResult = await wakeMod.wakeAgent(uid, { urgency: 'normal' });
    console.log('[boos] _onTaskAvailable: wakeAgent result:', wakeResult.ok ? 'success' : 'failed',
      'tasks_delivered:', wakeResult.tasks_delivered);

  } catch {
    const fails = (wakeMod._sendFailures.get(uid) || 0) + 1;
    wakeMod._sendFailures.set(uid, fails);
    if (fails >= wakeMod.MAX_SEND_FAILURES) {
      console.warn('[boos] notifications: agent', agent.name, '(' + uid.slice(-8) + ') send failures reached', fails);
    }
  }
}

// ── Root agent task handler ─────────────────────────────────────────────

async function _onRootAgentTask() {
  const ROOT_UID = store.ROOT_UID;
  const tasks = store.listPendingTasks(ROOT_UID);
  if (tasks.length === 0) return;
  for (const t of tasks) { await store.updateTaskStatus(t.task_id, 'in_progress', null); }
  if (_frontendNotify) {
    try {
      _frontendNotify('__root__', 'busy', {
        type: 'root_inbox', uid: ROOT_UID, name: 'BOOS Root', pending: tasks.length,
        tasks: tasks.map((t) => ({
          task_id: t.task_id, sender_name: t.sender_name, sender_uid: t.sender_uid,
          content: t.content, priority: t.priority, created_at: t.created_at,
        })),
      });
    } catch {}
  }
}

// ── HR Agent task handler ───────────────────────────────────────────────

async function _handleHrTask() {
  const tasks = store.listPendingTasks(_hrAgentUid);
  for (const t of tasks) {
    store.updateTaskStatus(t.task_id, 'in_progress', null);
    try {
      const result = await hrAgent.handleRecruitRequest(t.content, null, store, registry);
      if (result.ok) {
        await queue.respondTask(t.task_id, _hrAgentUid,
          `✅ 已招募 ${result.agent_name} (uid: ${result.agent_uid})\n` +
          `角色模板: ${result.role_template}\n项目: ${result.project || '无'}\n` +
          `Capabilities: ${result.capabilities.join(', ')}\n\n${result.hint}`);
      } else {
        await queue.respondTask(t.task_id, _hrAgentUid,
          `❌ 招募失败: ${result.error}\n可用角色: ${hrAgent.listAvailableRoles().map(r => r.title).join(', ')}`);
      }
    } catch (e) {
      await queue.respondTask(t.task_id, _hrAgentUid, `❌ 招募异常: ${e.message}`);
    }
  }
}

// ── Task lifecycle events ───────────────────────────────────────────────

async function _onTaskClaimed({ task_id, agent_uid, agent_name, sender_uid, priority, claimed_at }) {
  const match = await wakeMod._findSessionByUid(agent_uid);
  if (match && _frontendNotify) {
    try { _frontendNotify(match.id, 'busy', { type: 'task_lifecycle', event: 'task_claimed', task_id, agent_uid, sender_uid, priority, claimed_at }); } catch {}
  }
  if (sender_uid && _frontendNotify) {
    try {
      const senderMatch = await wakeMod._findSessionByUid(sender_uid);
      if (senderMatch) {
        _frontendNotify(senderMatch.id, 'idle', { type: 'task_lifecycle', event: 'task_claimed', task_id, claimed_by: agent_name, claimed_by_uid: agent_uid, claimed_at });
      }
    } catch {}
  }
}

// ── Sprint 38: Settlement Gate notifications ─────────────────────────────
// Fix: task_submitted and task_rejected_by_pm had no listeners.
// When a worker responds to a supervisor's task, respondTask() emits
// task_submitted — but no one was listening. PM never got notified that
// a worker submitted work for settlement. Similarly, task_rejected_by_pm
// was emitted when PM rejects a submission but no one notified the worker.

async function _onTaskSubmitted({ task_id, sender_uid, receiver_uid, receiver_name, result }) {
  // Notify the PM (sender_uid) that a worker has submitted work.
  const agent = store.getAgent(sender_uid);
  if (!agent) return;

  // SSE notify PM's frontend.
  let match = null;
  try { match = await wakeMod._findAnySessionByUid(sender_uid); } catch {}

  if (match && _frontendNotify) {
    try {
      _frontendNotify(match.id, 'idle', {
        type: 'task_lifecycle', event: 'task_submitted',
        task_id, receiver_uid, receiver_name,
        result_preview: (result || '').slice(0, 100),
        timestamp: new Date().toISOString(),
      });
    } catch {}
  }

  // Push settlement notification into PM's inbox.
  // Sprint 38 fix: use inboxStore.addPending (per-agent inbox file), NOT
  // store.insertTask (shared agent-bus.json). check_inbox reads from
  // inboxStore — the two stores were disconnected.
  try {
    const resultPreview = (result || '').trim()
      ? `"${(result || '').slice(0, 200)}"`
      : '(无文本摘要 — 请调用 settle_task approve/reject 审核)';
    const notifTask = {
      task_id: store.genTaskId(),
      sender_uid: receiver_uid,
      sender_name: (receiver_name || 'worker').slice(0, 64),
      sender_intro: '任务已提交 — 等待 PM 审核结算',
      receiver_uid: sender_uid,
      content: `任务 #${task_id} 已被 ${receiver_name || 'worker'} 提交，请审核结算 (settle_task approve/reject): ${resultPreview}`,
      priority: 'high',
      status: 'pending',
      reply_to: task_id,
      message_type: 'notification',
      required_capabilities: [],
      matched_via: 'settlement',
      metadata: { event: 'task_submitted', task_id, worker_uid: receiver_uid },
      created_at: new Date().toISOString(),
    };
    await inboxStore.addPending(sender_uid, notifTask);
  } catch (e) {
    console.warn('[boos] _onTaskSubmitted: failed to create notification task:', e.message);
  }

  // Wake the PM so they review and settle immediately.
  // Sprint 38 fix: skip wake if PM already has pending inbox items.
  // Cascading submissions (e.g. reconnection replay) would otherwise
  // trigger one PTY injection per submission, flooding the input buffer.
  // One wake is enough — the PM drains the queue via check_inbox loop.
  try {
    const inbox = inboxStore.loadInboxSync(sender_uid);
    const totalPending = inbox.pending.length + inbox.in_progress.length;
    if (totalPending <= 1) {
      await wakeMod.wakeAgent(sender_uid, {
        urgency: 'high',
        sender_name: receiver_name,
        sender_uid: receiver_uid,
        message: `${receiver_name}(${receiver_uid.slice(-8)}) submitted #${task_id} — PM settle required`,
      });
    }
  } catch {}
}

async function _onTaskRejectedByPM({ task_id, sender_uid, receiver_uid, feedback }) {
  // Notify the worker (receiver_uid) that PM rejected their submission.
  const agent = store.getAgent(receiver_uid);
  if (!agent) return;

  // SSE notify worker's frontend.
  let match = null;
  try { match = await wakeMod._findAnySessionByUid(receiver_uid); } catch {}

  if (match && _frontendNotify) {
    try {
      _frontendNotify(match.id, 'idle', {
        type: 'task_lifecycle', event: 'task_rejected_by_pm',
        task_id, feedback: feedback || '',
        timestamp: new Date().toISOString(),
      });
    } catch {}
  }

  // Push rejection notification into worker's inbox.
  // Sprint 38 fix: use inboxStore, not store.insertTask — see _onTaskSubmitted.
  try {
    const notifTask = {
      task_id: store.genTaskId(),
      sender_uid: sender_uid,
      sender_name: 'PM',
      sender_intro: '任务驳回通知',
      receiver_uid: receiver_uid,
      content: `任务 #${task_id} 被驳回，需修改后重新提交。反馈: "${(feedback || '').slice(0, 200)}"`,
      priority: 'high',
      status: 'pending',
      reply_to: task_id,
      message_type: 'notification',
      required_capabilities: [],
      matched_via: 'settlement',
      metadata: { event: 'task_rejected_by_pm', task_id, feedback },
      created_at: new Date().toISOString(),
    };
    await inboxStore.addPending(receiver_uid, notifTask);
  } catch (e) {
    console.warn('[boos] _onTaskRejectedByPM: failed to create notification task:', e.message);
  }

  // Wake the worker so they can fix and resubmit.
  // Sprint 38 fix: skip wake if worker already has pending inbox items.
  try {
    const inbox = inboxStore.loadInboxSync(receiver_uid);
    const totalPending = inbox.pending.length + inbox.in_progress.length;
    if (totalPending <= 1) {
      await wakeMod.wakeAgent(receiver_uid, {
        urgency: 'normal',
        sender_name: 'PM',
        sender_uid: sender_uid,
        message: `PM rejected #${task_id}: ${(feedback || '').slice(0, 50)}`,
      });
    }
  } catch {}
}

async function _onTaskCompleted({ task_id, sender_uid, receiver_uid, receiver_name, result, metadata }) {
  // Sprint 38: notification tasks are FYI — completing one must not
  // trigger another completion notification. Without this guard, the
  // chain is: ACK → auto-complete → task_completed → new notification
  // → ACK → … → ∞. queue.js also skips the emit for notification tasks,
  // but this guard is defense-in-depth in case task_completed fires from
  // another path (e.g. settle_task approve).
  if (metadata?.message_type === 'notification' || metadata?.matched_via === 'notification') return;

  const ROOT_UID = store.ROOT_UID;

  // Root agent completion — push SSE transport to receiver + frontend.
  if (sender_uid === ROOT_UID) {
    if (_frontendNotify) {
      try { _frontendNotify('__root__', 'idle', { type: 'root_task_completed', task_id, receiver_uid, receiver_name, result: (result || '').slice(0, 100) }); } catch {}
    }
    try {
      const { notifyAgent } = require('./transport');
      notifyAgent(receiver_uid, 'notifications/agent_bus/root_response', {
        task_id, result_preview: (result || '').slice(0, 200), receiver_uid, timestamp: new Date().toISOString(),
      });
    } catch {}
    return;
  }

  // Resolve sender identity (best-effort — never block the notification).
  const agent = store.getAgent(sender_uid);
  let match = null;
  if (agent) {
    try { match = await wakeMod._findAnySessionByUid(sender_uid); } catch {}
  }

  if (agent && match) {
    // Frontend SSE — task lifecycle events (require both agent record + active session).
    if (_frontendNotify) {
      try {
        if (match.status === 'running') {
          _frontendNotify(match.id, 'idle', { type: 'task_lifecycle', event: 'task_completed', task_id, receiver_uid, receiver_name, sender_uid, result_preview: (result || '').slice(0, 100), timestamp: new Date().toISOString() });
          _frontendNotify(match.id, 'working', { uid: sender_uid, name: agent.name, reason: 'task_completed', task_id, by: receiver_name });
        }
      } catch {}
    }

    if (_frontendNotify && receiver_uid) {
      try {
        const recv = store.getAgent(receiver_uid);
        if (recv) {
          const recvMatch = await wakeMod._findAnySessionByUid(receiver_uid);
          if (recvMatch) _frontendNotify(recvMatch.id, 'idle', { uid: receiver_uid, name: recv.name, reason: 'task_done', task_id });
        }
      } catch {}
    }
  } else {
    // Log the gap but don't block — the inbox notification + wake below are what matter.
    if (!agent) wakeMod._logDeliveryFailure(sender_uid, '(unknown)', 'agent record not found — inbox notification still inserted');
    else wakeMod._logDeliveryFailure(sender_uid, agent.name, 'no BOOS session — inbox notification still inserted, wake will auto-resume');
  }

  // Push completion notification task into sender's inbox.
  // ALWAYS do this — it's the only way the sender knows the task is done.
  // Sprint 38 fix: use inboxStore, not store.insertTask.
  try {
    const notifTask = {
      task_id: store.genTaskId(),
      sender_uid: receiver_uid || 'system',
      sender_name: (receiver_name || '系统').slice(0, 64),
      sender_intro: '任务完成通知',
      receiver_uid: sender_uid,
      content: `任务已完成: "${(result || '').slice(0, 80)}"`,
      priority: 'normal',
      status: 'pending',
      reply_to: task_id,
      message_type: 'notification',
      required_capabilities: [],
      matched_via: 'notification',
      metadata: metadata || null,
      created_at: new Date().toISOString(),
    };
    await inboxStore.addPending(sender_uid, notifTask);
  } catch (e) { console.warn('[boos] _onTaskCompleted: failed to create notification task:', e.message); }

  // Wake sender so they see the response immediately.
  // wakeAgent handles auto-resume internally if the agent has no active connection.
  // Sprint 38 fix: skip wake if sender already has pending inbox items.
  if (agent) {
    try {
      const inbox = inboxStore.loadInboxSync(sender_uid);
      const totalPending = inbox.pending.length + inbox.in_progress.length;
      if (totalPending <= 1) {
        await wakeMod.wakeAgent(sender_uid, { urgency: 'normal', sender_name: receiver_name, sender_uid: receiver_uid, message: `${receiver_name}(${(receiver_uid || 'system').slice(-8)}) completed #${task_id}` });
      }
    } catch {}
  }
}

// ── Interrupt notification ──────────────────────────────────────────────

async function _onTaskInterrupted(taskId, receiverUid, receiverName, taskContent) {
  const match = await wakeMod._findSessionByUid(receiverUid);
  if (!match || !_frontendNotify) return;
  try { _frontendNotify(match.id, 'idle', { uid: receiverUid, name: receiverName, reason: 'interrupted', task_id: taskId }); } catch {}
}

// ── Queue scanning ──────────────────────────────────────────────────────

function checkAllQueues() {
  _pendingQueues.clear();
  const allAgents = store.listAllAgents();
  for (const agent of allAgents) {
    if (store.countPendingTasks(agent.uid) > 0) _pendingQueues.add(agent.uid);
  }
  return Array.from(_pendingQueues);
}

function hasPendingTasks(uid) { return store.countPendingTasks(uid) > 0; }

module.exports = {
  start, stop,
  wakeAgent: wakeMod.wakeAgent,
  compactAllWorkers: wakeMod.compactAllWorkers,
  setFrontendNotify,
  _onTaskInterrupted,
  checkAllQueues, hasPendingTasks,
  onTaskClaimed: wakeMod.onTaskClaimed,
  cancelTaskTimeoutTracking: wakeMod.cancelTaskTimeoutTracking,
  _scheduleTaskTimeout: wakeMod._scheduleTaskTimeout,
};

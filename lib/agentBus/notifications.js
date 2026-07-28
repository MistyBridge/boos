// BOOS → Agent-Bus in-process push notification bridge.
//
// Event-driven architecture: send_task → inboxEvents('task_available') →
// mark in_progress → SSE notifyAgent(). Agent calls check_inbox() →
// processes → respond_task → outboxEvents('task_completed') → SSE push.
//
// Split across 2 modules (Sprint 31 — ≤500 lines each):
//   notifications.js     — event routing + HR agent + frontend bridge (this file)
//   notificationsWake.js — wake agent + PTY injection + task timeout + compact

'use strict';

const path = require('path');
const queue = require('./queue');
const store = require('./store');
const registry = require('./registry');
const collaborationLoop = require('./collaborationLoop');
const taskAnalytics = require('./taskAnalytics');
const hrAgent = require('../hrAgent');
const taskTimeout = require('./taskTimeout');
const persistedSessions = require('../persistedSessions');
const webTerminal = require('../webTerminal');
const wakeMod = require('./notificationsWake');

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

  // Ensure generalist catch-all agent exists.
  const ws = workspace || 'boos';
  try {
    await collaborationLoop.ensureGeneralistAgent(registry, ws);
    console.log('[boos] collaboration loop: generalist agent ready (workspace=' + ws + ')');
  } catch (e) { console.warn('[boos] collaboration loop: generalist agent init failed:', e.message); }

  // Root Agent — permanent human↔agent communication bridge.
  try {
    const rootResult = await registry.registerRootAgent({
      name: 'BOOS Root',
      intro: 'BOOS 系统根代理 — 人类与 Agent 之间的通信桥梁。Agent 发送任务到此代理即表示请求人类关注或决策。',
    });
    console.log('[boos] root agent registered:', rootResult.uid, rootResult.reconnected ? '(reconnected)' : '(new)');
  } catch (e) { console.warn('[boos] root agent init failed:', e.message); }

  // HR Agent — auto-register and handle recruitment requests.
  try {
    const hrResult = await registry.registerAgent({
      name: 'HR Agent',
      intro: 'BOOS 内嵌 HR Agent — 自动角色招募系统。',
      workspace: ws, role: 'worker', capabilities: ['recruitment', 'hr'],
    });
    _hrAgentUid = hrResult.uid;
    console.log('[boos] HR Agent registered:', _hrAgentUid);
    queue.inboxEvents.on('task_available', async (uid) => {
      if (uid !== _hrAgentUid) return;
      await _handleHrTask();
    });
  } catch (e) { console.warn('[boos] HR Agent init failed:', e.message); }

  // Recruitment suggestions → supervisor's PTY.
  taskAnalytics.analyticsEvents.on('recruitment_suggested', async (suggestion) => {
    try {
      const supervisors = store.listAgentsInWorkspace(ws).filter((a) => a.role === 'supervisor');
      for (const sup of supervisors) {
        const match = await wakeMod._findSessionByUid(sup.uid);
        if (!match) continue;
        const term = webTerminal.get(match.id);
        if (!term || term.exitedAt) continue;
        const capName = { ui: '前端工程师', frontend: '前端工程师', testing: '测试工程师', e2e: '测试工程师',
          integration: '平台集成工程师', mcp: '平台集成工程师', protocol: '平台集成工程师',
          backend: '后端工程师', architecture: '架构师', devops: 'DevOps工程师' }[suggestion.capability] || suggestion.capability;
        wakeMod._writeToPty(match.id,
          `\n[agent-bus] 📊 任务分析: 过去1小时有 ${suggestion.count} 个 "${capName}" 类任务。是否通过 HR Agent 招募${capName}？\r\n`);
      }
    } catch {}
  });

  // 24h timeout → archive.
  taskTimeout.start(store, async (task) => {
    try {
      const archivePath = require('node:path').join(
        require('./config').DATA_DIR, 'archive', 'tasks',
        new Date().toISOString().slice(0, 7), task.task_id + '.json');
      const senderAg = store.getAgent(task.sender_uid);
      if (senderAg) {
        const sm = await wakeMod._findSessionByUid(task.sender_uid);
        if (sm) wakeMod._writeToPty(sm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id + ': 超过24h已归档\r\n');
      }
    } catch {}
  });

  // Heartbeat + crash recovery scanner.
  try {
    const heartbeat = require('./heartbeat');
    heartbeat.start(store, {
      onUnresponsive(uid, name, reassigned) {
        console.log('[boos] heartbeat: agent', name, 'unresponsive —', reassigned, 'tasks reassigned');
      },
    });
  } catch (e) { console.warn('[boos] heartbeat init failed:', e.message); }

  // Stale in_progress task reclaimer (every 60s, returns to pending after 120s).
  _staleTimer = setInterval(async () => {
    try {
      const db = await store._load();
      const now = Date.now();
      let n = 0;
      for (const t of Object.values(db.tasks || {})) {
        if (t.status !== 'in_progress' || t.receiver_uid === store.ROOT_UID) continue;
        if (now - new Date(t.updated_at).getTime() < 120_000) continue;
        await store.updateTaskStatus(t.task_id, 'pending', null);
        n++;
        setImmediate(() => queue.inboxEvents.emit('task_available', t.receiver_uid));
      }
      if (n > 0) console.log('[boos] stale-reclaim:', n, 'tasks in_progress→pending');
    } catch {}
  }, 60_000);
  _staleTimer.unref();

  console.log('[boos] agent-bus push notifications active (in+out, zero-polling)');
}

function stop() {
  if (!_started) return;
  _started = false;
  try { require('./heartbeat').stop(); } catch {}
  if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
  queue.inboxEvents.removeListener('task_available', _onTaskAvailable);
  queue.outboxEvents.removeListener('task_completed', _onTaskCompleted);
  queue.outboxEvents.removeListener('task_claimed', _onTaskClaimed);
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

    // Trigger PTY wake.
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

async function _onTaskCompleted({ task_id, sender_uid, receiver_uid, receiver_name, result, metadata }) {
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

  const agent = store.getAgent(sender_uid);
  if (!agent) { wakeMod._logDeliveryFailure(sender_uid, '(unknown)', 'agent record not found'); return; }
  const match = await wakeMod._findSessionByUid(sender_uid);
  if (!match) { wakeMod._logDeliveryFailure(sender_uid, agent.name, 'no running BOOS session'); return; }

  // Frontend SSE — task lifecycle events.
  if (_frontendNotify) {
    try {
      _frontendNotify(match.id, 'idle', { type: 'task_lifecycle', event: 'task_completed', task_id, receiver_uid, receiver_name, sender_uid, result_preview: (result || '').slice(0, 100), timestamp: new Date().toISOString() });
    } catch {}
    try { _frontendNotify(match.id, 'working', { uid: sender_uid, name: agent.name, reason: 'task_completed', task_id, by: receiver_name }); } catch {}
  }

  if (_frontendNotify && receiver_uid) {
    try {
      const recv = store.getAgent(receiver_uid);
      if (recv) {
        const recvMatch = await wakeMod._findSessionByUid(receiver_uid);
        if (recvMatch) _frontendNotify(recvMatch.id, 'idle', { uid: receiver_uid, name: recv.name, reason: 'task_done', task_id });
      }
    } catch {}
  }

  // Wake sender so they see the response immediately.
  try { await wakeMod.wakeAgent(sender_uid, { urgency: 'normal', message: `任务 #${task_id} 已被 ${receiver_name} 完成` }); } catch {}

  // Push completion notification task into sender's inbox.
  try {
    await store.insertTask({
      task_id: store.genTaskId(), sender_uid: receiver_uid || 'system',
      sender_name: receiver_name || '系统', sender_intro: '任务完成通知',
      receiver_uid: sender_uid,
      content: `任务已完成: "${(result || '').slice(0, 80)}"`,
      priority: 'normal', status: 'notification', result: null,
      reply_to: task_id, required_capabilities: [], matched_via: 'notification',
      metadata: metadata || null, created_at: new Date().toISOString(),
    });
  } catch (e) { console.warn('[boos] _onTaskCompleted: failed to create notification task:', e.message); }
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

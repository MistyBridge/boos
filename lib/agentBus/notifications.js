// BOOS → Agent-Bus in-process push notification bridge.
//
// Replaces lib/agentBusWatcher.js. Instead of connecting to an external
// agent-bus process via SSE, this listens directly to queue.inboxEvents
// (EventEmitter) within the same process.
//
// Flow:
//   queue.sendTask → 0→1 inbox transition
//        ↓ queue.inboxEvents.emit('task_available', uid)
//   notifications.js: resolve uid → get pending tasks → BOOS session → PTY
//        ↓ pty.write("<task content directly>")
//   Agent: receives task content inline — no manual check_inbox required.

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

// ── Frontend activity bridge (Sprint 9) ─────────────────────────────
// Set by routes/agents.js when the SSE channel comes online.
// Called with (sessionId, activity, meta?) to push agent-bus state
// changes to the frontend Agent Canvas in real time.
let _frontendNotify = null;
function setFrontendNotify(fn) { _frontendNotify = fn; }

let _hrAgentUid = null;

const DEBOUNCE_MS = 1000;  // Sprint 11: auto-deliver every batch (was 30s)

let _started = false;
const _lastWake = new Map();

async function start(workspace) {
  if (_started) return;
  _started = true;

  queue.inboxEvents.on('task_available', _onTaskAvailable);
  queue.outboxEvents.on('task_completed', _onTaskCompleted);

  // Sprint 8 #72: ensure generalist catch-all agent exists.
  const ws = workspace || 'boos';
  try {
    await collaborationLoop.ensureGeneralistAgent(registry, ws);
    console.log('[boos] collaboration loop: generalist agent ready (workspace=' + ws + ')');
  } catch (e) {
    console.warn('[boos] collaboration loop: generalist agent init failed:', e.message);
  }

  // Sprint 13: Root Agent — permanent human↔agent communication bridge.
  try {
    const rootResult = await registry.registerRootAgent({
      name: 'BOOS Root',
      intro: 'BOOS 系统根代理 — 人类与 Agent 之间的通信桥梁。Agent 发送任务到此代理即表示请求人类关注或决策。',
    });
    console.log('[boos] root agent registered:', rootResult.uid, rootResult.reconnected ? '(reconnected)' : '(new)');
  } catch (e) {
    console.warn('[boos] root agent init failed:', e.message);
  }

  // Sprint 8 #65: HR Agent — auto-register and handle recruitment requests.
  try {
    const hrResult = await registry.registerAgent({
      name: 'HR Agent',
      intro: 'BOOS 内嵌 HR Agent — 自动角色招募系统。收到招募请求时自动从 D:\\AI_Ex\\HR\\ 资产库匹配角色模板并创建 agent。',
      workspace: ws,
      role: 'worker',
      capabilities: ['recruitment', 'hr'],
    });
    _hrAgentUid = hrResult.uid;
    console.log('[boos] HR Agent registered:', _hrAgentUid);

    // Listen for tasks sent to HR Agent — process recruitment automatically.
    queue.inboxEvents.on('task_available', async (uid) => {
      if (uid !== _hrAgentUid) return;
      await _handleHrTask();
    });
  } catch (e) {
    console.warn('[boos] HR Agent init failed:', e.message);
  }

  // Sprint 8 #73: recruitment suggestions → supervisor's PTY.
  taskAnalytics.analyticsEvents.on('recruitment_suggested', async (suggestion) => {
    try {
      const supervisors = store.listAgentsInWorkspace(ws).filter((a) => a.role === 'supervisor');
      for (const sup of supervisors) {
        const match = await _findSession(sup.name, sup.workspace);
        if (!match) continue;
        const term = webTerminal.get(match.id);
        if (!term || term.exitedAt) continue;
        const capName = { ui: '前端工程师', frontend: '前端工程师', testing: '测试工程师', e2e: '测试工程师',
          integration: '平台集成工程师', mcp: '平台集成工程师', protocol: '平台集成工程师',
          backend: '后端工程师', architecture: '架构师', devops: 'DevOps工程师' }[suggestion.capability] || suggestion.capability;
        _writeToPty(match.id,
          `\n[agent-bus] 📊 任务分析: 过去1小时有 ${suggestion.count} 个 "${capName}" 类任务（capability: ${suggestion.capability}）。是否通过 HR Agent 招募${capName}？\n`);
      }
    } catch {}
  });

  // Sprint 11 revised: 24h timeout → archive (single notification).
  // taskTimeout.js fires onTimeout exactly once per task id.
  taskTimeout.start(store, async (task) => {
    try {
      const archivePath = require('node:path').join(
        require('./config').DATA_DIR, 'archive', 'tasks',
        new Date().toISOString().slice(0, 7), task.task_id + '.json',
      );
      // Notify sender.
      const senderAg = store.getAgent(task.sender_uid);
      if (senderAg) {
        const sm = await _findSessionByUid(task.sender_uid, senderAg.name, senderAg.workspace);
        if (sm) _writeToPty(sm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id
          + ': 超过24h已归档 → ' + archivePath + '\n');
      }
      // Notify receiver.
      const recvAg = store.getAgent(task.receiver_uid);
      if (recvAg) {
        const rm = await _findSessionByUid(task.receiver_uid, recvAg.name, recvAg.workspace);
        if (rm) _writeToPty(rm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id
          + ': 超过24h未响应，已归档。可通过 task ID 回溯。\n');
      }
    } catch {}
  });

  // Sprint 10: heartbeat + crash recovery scanner.
  try {
    const heartbeat = require('./heartbeat');
    heartbeat.start(store, {
      onUnresponsive(uid, name, reassigned) {
        console.log('[boos] heartbeat: agent', name, 'unresponsive —', reassigned, 'tasks reassigned');
      },
    });
  } catch (e) {
    console.warn('[boos] heartbeat init failed:', e.message);
  }

  // Sprint 13: PTY watchdog removed — replaced by wake-before-deliver.
  // Sprint 13.3: heartbeat scanner converted to event-driven per-agent
  // timeouts (no more 30s global polling). All agent state management
  // is now push-based via the agent-bus layer.

  console.log('[boos] agent-bus push notifications active (in+out, zero-polling)');
}

function stop() {
  if (!_started) return;
  _started = false;
  try { require('./heartbeat').stop(); } catch {}
  queue.inboxEvents.removeListener('task_available', _onTaskAvailable);
  queue.outboxEvents.removeListener('task_completed', _onTaskCompleted);
}

// ── send failure tracking (Sprint 9) ──────────────────────────────────
const _sendFailures = new Map(); // uid → count
const MAX_SEND_FAILURES = 3;

// Sprint 13 track wake-attempt counts to prevent infinite retry loops.
const _wakeAttempts = new Map(); // uid → count
const MAX_WAKE_ATTEMPTS = 3;

async function _onTaskAvailable(uid) {
  const ROOT_UID = store.ROOT_UID;

  // Sprint 13: Root agent — no PTY, push to frontend SSE.
  if (uid === ROOT_UID) { await _onRootAgentTask(); return; }

  // Debounce: max one delivery per agent per 1s.
  const last = _lastWake.get(uid) || 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  _lastWake.set(uid, Date.now());

  const agent = store.getAgent(uid);
  if (!agent) return;

  // Sprint 13: identity card lookup → wake-before-deliver.
  let match = await _findSessionByUid(uid, agent.name, agent.workspace);

  if (!match) {
    // Agent is registered but has no live session — try to wake.
    const attempts = _wakeAttempts.get(uid) || 0;
    if (attempts < MAX_WAKE_ATTEMPTS) {
      _wakeAttempts.set(uid, attempts + 1);
      console.log('[boos] wake-before-deliver: launching session for', agent.name, '(attempt ' + (attempts + 1) + ')');
      try {
        const { _internalLaunchAgentSession } = require('./handlers');
        await _internalLaunchAgentSession(uid, agent.name, agent.workspace);
        match = await _findSessionByUid(uid, agent.name, agent.workspace);
      } catch (e) {
        console.warn('[boos] wake-before-deliver failed for', agent.name, e.message);
      }
    }

    if (!match) {
      _logDeliveryFailure(uid, agent.name, 'no running BOOS session (wake attempts: ' + attempts + ')');
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        console.warn('[boos] agent', agent.name, 'unreachable after', MAX_WAKE_ATTEMPTS, 'wake attempts');
        _wakeAttempts.delete(uid);
      }
      return;
    }
    // Reset attempts on successful wake.
    _wakeAttempts.delete(uid);
  }

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) { _logDeliveryFailure(uid, agent.name, 'PTY not available'); return; }

  // Deliver ALL pending tasks — no manual check_inbox needed.
  const tasks = store.listPendingTasks(uid);
  if (tasks.length === 0) return;

  try {
    const lines = tasks.map((t) => {
      const sender = t.sender_name || 'unknown';
      const prio = t.priority === 'high' ? '🔴' : t.priority === 'urgent' ? '⚡' : '';
      let header;
      if (t.reply_to) {
        header = `[agent-bus] ↩️ ${sender} 回覆 #${t.reply_to}:`;
      } else if (prio) {
        header = `[agent-bus] ${prio} ${sender}:`;
      } else {
        header = `[agent-bus] 📨 ${sender}:`;
      }
      return `\n${header}\n${t.content}\n`;
    });
    for (const t of tasks) {
      store.updateTaskStatus(t.task_id, 'in_progress', null);
    }
    const claimLines = tasks.map((t) => `[agent-bus] 📨 任务已自动认领 #${t.task_id}`);
    lines.push(claimLines.join('\n'));
    _writeToPty(match.id, lines.join('') + '\n');

    if (_frontendNotify) {
      try { _frontendNotify(match.id, 'busy', { uid, name: agent.name, pending: tasks.length }); } catch {}
    }

    _sendFailures.delete(uid);
  } catch {
    const fails = (_sendFailures.get(uid) || 0) + 1;
    _sendFailures.set(uid, fails);
    if (fails >= MAX_SEND_FAILURES) {
      console.warn('[boos] notifications: agent', agent.name, '(' + uid.slice(-8) + ') send failures reached', fails, '— agent appears offline');
    }
  }
}

// Sprint 13: handle root agent tasks — push to frontend SSE for Decision Area UI.
async function _onRootAgentTask() {
  const ROOT_UID = store.ROOT_UID;
  const tasks = store.listPendingTasks(ROOT_UID);
  if (tasks.length === 0) return;

  for (const t of tasks) {
    await store.updateTaskStatus(t.task_id, 'in_progress', null);
  }

  if (_frontendNotify) {
    try {
      _frontendNotify('__root__', 'busy', {
        type: 'root_inbox',
        uid: ROOT_UID,
        name: 'BOOS Root',
        pending: tasks.length,
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          sender_name: t.sender_name,
          sender_uid: t.sender_uid,
          content: t.content,
          priority: t.priority,
          created_at: t.created_at,
        })),
      });
    } catch {}
  }
}

// ── HR Agent task handler ─────────────────────────────────────────────

async function _handleHrTask() {
  const tasks = store.listPendingTasks(_hrAgentUid);
  for (const t of tasks) {
    // Claim the task.
    store.updateTaskStatus(t.task_id, 'in_progress', null);
    try {
      const result = await hrAgent.handleRecruitRequest(
        t.content,
        null, // agentBusUrl — use default
        store,
        registry,
      );
      if (result.ok) {
        await queue.respondTask(t.task_id, _hrAgentUid,
          `✅ 已招募 ${result.agent_name} (uid: ${result.agent_uid})\n` +
          `角色模板: ${result.role_template}\n` +
          `项目: ${result.project || '无'}\n` +
          `Capabilities: ${result.capabilities.join(', ')}\n\n` +
          `${result.hint}`);
      } else {
        await queue.respondTask(t.task_id, _hrAgentUid,
          `❌ 招募失败: ${result.error}\n可用角色: ${hrAgent.listAvailableRoles().map(r => r.title).join(', ')}`);
      }
    } catch (e) {
      await queue.respondTask(t.task_id, _hrAgentUid, `❌ 招募异常: ${e.message}`);
    }
  }
}

// ── outbound notification: sender learns when task completes ─────────

async function _onTaskCompleted({ task_id, sender_uid, receiver_uid, receiver_name, result }) {
  const ROOT_UID = store.ROOT_UID;

  // Sprint 13: Root agent completion — push to frontend SSE, skip PTY.
  if (sender_uid === ROOT_UID) {
    if (_frontendNotify) {
      try {
        _frontendNotify('__root__', 'idle', {
          type: 'root_task_completed',
          task_id, receiver_uid, receiver_name,
          result: (result || '').slice(0, 100),
        });
      } catch {}
    }
    return;
  }

  const agent = store.getAgent(sender_uid);
  if (!agent) { _logDeliveryFailure(sender_uid, '(unknown)', 'agent record not found'); return; }

  const match = await _findSessionByUid(sender_uid, agent.name, agent.workspace);
  if (!match) { _logDeliveryFailure(sender_uid, agent.name, 'no running BOOS session'); return; }

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) { _logDeliveryFailure(sender_uid, agent.name, 'PTY not available'); return; }

  const preview = (result || '').split('\n')[0].slice(0, 80);
  const msg = `\n[agent-bus] ✅ ${receiver_name} 完成 #${task_id}: ${preview}\n`;
  try {
    webTerminal.write(match.id, msg);
  } catch {}

  // Sprint 9: push completion event to frontend canvas for the sender (A).
  if (_frontendNotify) {
    try {
      _frontendNotify(match.id, 'working', {
        uid: sender_uid, name: agent.name,
        reason: 'task_completed', task_id, by: receiver_name,
      });
    } catch {}
  }

  // Also mark the receiver (B) as idle on the canvas (task DONE).
  if (_frontendNotify && receiver_uid) {
    try {
      const recv = store.getAgent(receiver_uid);
      if (recv) {
        const recvMatch = await _findSessionByUid(receiver_uid, recv.name, recv.workspace);
        if (recvMatch) {
          _frontendNotify(recvMatch.id, 'idle', {
            uid: receiver_uid, name: recv.name,
            reason: 'task_done', task_id,
          });
        }
      }
    } catch {}
  }

  // Wake the sender agent so they see the response immediately.
  // The SSE notification triggers check_inbox(wait=true) to return.
  try {
    const { notifyAgent } = require('./transport');
    notifyAgent(sender_uid, 'notifications/agent_bus/task_completed', {
      task_id, receiver_name, preview, timestamp: new Date().toISOString(),
    });
  } catch {}
}

// Sprint 13: identity card lookup — deterministic session resolution.
// Replaces the old MCP-session-ID-to-BOOS-session-ID heuristic (Pass 0 was
// always broken because mcp_<uuid> ≠ sess-<ts>-<rand>).

async function _findSession(agentName, workspace) {
  // Try identity card by name+workspace first.
  const identity = store.getIdentity({ name: agentName, workspace });
  if (identity?.boos_session_id) {
    const all = await persistedSessions.loadAll();
    const m = all.find((s) => s.id === identity.boos_session_id);
    if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
  }
  // Legacy fallback: heuristic cwd basename matching.
  return persistedSessions.findByAgentName(agentName, workspace);
}

async function _findSessionByUid(uid, agentName, workspace) {
  // Pass 1: identity card by UID → boos_session_id.
  const id1 = store.getIdentity({ uid });
  if (id1?.boos_session_id) {
    const all = await persistedSessions.loadAll();
    const m = all.find((s) => s.id === id1.boos_session_id);
    if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
  }
  // Pass 2: identity card by name+workspace (cross-reference).
  const id2 = store.getIdentity({ name: agentName, workspace });
  if (id2?.boos_session_id && id2.agent_uid !== uid) {
    const all = await persistedSessions.loadAll();
    const m = all.find((s) => s.id === id2.boos_session_id);
    if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
  }
  // Pass 3: legacy heuristic fallback.
  return _findSession(agentName, workspace);
}

function _writeToPty(sessionId, data) {
  try {
    webTerminal.write(sessionId, data);
  } catch (e) {
    console.warn('[boos] notifications: PTY write failed for session', sessionId, e.message);
  }
}

// ── outbound delivery log (debuggable) ─────────────────────────────────

function _logDeliveryFailure(uid, agentName, reason) {
  console.log('[boos] notifications: outbound delivery failed for', agentName, '(' + uid + '):', reason);
}

// ── Wake agent on demand (bypasses debounce) ──────────────────────────
// Called by the wake_agent MCP tool. Unlike the automatic 0→1 inbox
// notification (which is debounced 30s), this fires immediately every
// time to support on-demand cross-agent wake-up.

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const match = await _findSessionByUid(uid, agent.name, agent.workspace);
  if (!match) return { ok: false, error: 'no running BOOS session found for agent ' + agent.name };

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) return { ok: false, error: 'agent PTY not available' };

  const urgency = opts.urgency || 'normal';
  const customMsg = (opts.message || '').slice(0, 256);
  const wakeMsg = urgency === 'urgent'
    ? `\n[agent-bus] ⚡ ${customMsg || '紧急协作任务 — 请立即处理。'}\n`
    : `\n[agent-bus] 🔔 ${customMsg || '新的协作任务已送达。'}\n`;

  try {
    _writeToPty(match.id, wakeMsg);
    // Sprint 9: push wake event to frontend canvas.
    if (_frontendNotify) {
      try { _frontendNotify(match.id, 'woken', { uid, name: agent.name }); } catch {}
    }
    // Track last wake for debounce-aware callers (but we always fire)
    _lastWake.set(uid, Date.now());
    return { ok: true, agent_uid: uid, agent_name: agent.name, session_id: match.id, urgency };
  } catch (e) {
    return { ok: false, error: 'PTY write failed: ' + e.message };
  }
}

// Sprint 10 R11: Notify receiver that their task has been interrupted/preempted.
// Pushes PTY message + SSE status update so the agent drops current work.
async function _onTaskInterrupted(taskId, receiverUid, receiverName, taskContent) {
  const match = await _findSessionByUid(receiverUid, receiverName, 'boos');
  if (!match) return;

  const preview = (taskContent || '').split('\n')[0].slice(0, 80);
  const msg = `\n[agent-bus] ⚠️ 任务 #${taskId} 被抢占: ${preview}\n[agent-bus] 📋 此任务已回收至待办队列，处理完高优任务后仍可认领。\n`;

  try { _writeToPty(match.id, msg); } catch {}

  // Push SSE canvas update: mark receiver as idle (ready for new work).
  if (_frontendNotify) {
    try {
      _frontendNotify(match.id, 'idle', {
        uid: receiverUid, name: receiverName,
        reason: 'interrupted', task_id: taskId,
      });
    } catch {}
  }
}

module.exports = { start, stop, wakeAgent, setFrontendNotify, _onTaskInterrupted };

// BOOS → Agent-Bus in-process push notification bridge.
//
// Architecture (Sprint 16): Agent-to-agent communication flows exclusively
// through SSE transport. PTY is reserved for human ↔ CLI interaction only.
//
//   send_task → inboxEvents('task_available') → mark in_progress → SSE notifyAgent()
//        ↓ transport.js pushes to agent's MCP SSE connection
//   Agent: check_inbox(wait=true) unblocks → queue.respondTask
//        ↓ outboxEvents('task_completed') → SSE frontend + SSE transport
//
//   System-level notifications (timeout, recruitment) only still use PTY.
//   Task content NEVER touches the PTY channel.

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
let _staleTimer = null;  // Sprint 17: stale task reclaimer handle

const DEBOUNCE_MS = 1000;  // Sprint 11: auto-deliver every batch (was 30s)

let _started = false;
const _lastWake = new Map();
const _pendingQueues = new Set(); // M3: Track agents with pending tasks

async function start(workspace) {
  if (_started) return;
  _started = true;

  queue.inboxEvents.on('task_available', _onTaskAvailable);
  queue.outboxEvents.on('task_completed', _onTaskCompleted);
  queue.outboxEvents.on('task_claimed', _onTaskClaimed);    // A3: task lifecycle

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
          `\n[agent-bus] 📊 任务分析: 过去1小时有 ${suggestion.count} 个 "${capName}" 类任务（capability: ${suggestion.capability}）。是否通过 HR Agent 招募${capName}？\r\n`);
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
          + ': 超过24h已归档 → ' + archivePath + '\r\n');
      }
      // Notify receiver.
      const recvAg = store.getAgent(task.receiver_uid);
      if (recvAg) {
        const rm = await _findSessionByUid(task.receiver_uid, recvAg.name, recvAg.workspace);
        if (rm) _writeToPty(rm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id
          + ': 超过24h未响应，已归档。可通过 task ID 回溯。\r\n');
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

  // Sprint 17: stale in_progress task reclaimer.
  // If agent picks up task (check_inbox) but never calls respond_task,
  // flip it back to pending after 120s so it reappears on next check_inbox.
  _staleTimer = setInterval(async () => {
    try {
      const db = await store._load();
      const now = Date.now();
      let n = 0;
      for (const t of Object.values(db.tasks || {})) {
        if (t.status !== "in_progress" || t.receiver_uid === store.ROOT_UID) continue;
        if (now - new Date(t.updated_at).getTime() < 120_000) continue;
        await store.updateTaskStatus(t.task_id, "pending", null);
        n++;
        setImmediate(() => queue.inboxEvents.emit("task_available", t.receiver_uid));
      }
      if (n > 0) console.log("[boos] stale-reclaim:", n, "tasks in_progress->pending");
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
  if (tasks.length === 0) {
    _pendingQueues.delete(uid); // M3: Remove from pending set if no tasks
    return;
  }

  // M3: Mark this agent as having pending tasks
  _pendingQueues.add(uid);

  try {
    // M4: Event-driven trigger — keep tasks pending until agent actually processes them
    // DO NOT mark tasks as in_progress here. Let the agent claim them via check_inbox.

    // M3: Mark this agent as having pending tasks
    _pendingQueues.add(uid);

    // SSE transport: push notification to agent's MCP client.
    // This unblocks check_inbox(wait=true) if agent is waiting.
    try {
      const { notifyAgent } = require('./transport');
      notifyAgent(uid, 'notifications/agent_bus/inbox_updated', {
        uid, agent_name: agent.name, workspace: agent.workspace,
        pending: tasks.length,
        task_ids: tasks.map((t) => t.task_id),
      });
    } catch {}

    // A3: Frontend SSE — push task_lifecycle events for each pending task.
    // Non-root tasks now get full task-level lifecycle visibility (not just
    // activity-busy), so the Agent Canvas can show individual task state.
    if (_frontendNotify) {
      for (const t of tasks) {
        try {
          _frontendNotify(match.id, 'busy', {
            type: 'task_lifecycle',
            event: 'task_available',
            task_id: t.task_id,
            receiver_uid: uid,
            sender_name: t.sender_name || (store.getAgent(t.sender_uid)?.name || ''),
            sender_uid: t.sender_uid,
            priority: t.priority,
            content_preview: (t.content || '').slice(0, 100),
            created_at: t.created_at,
          });
        } catch {}
      }
      try { _frontendNotify(match.id, 'busy', { uid, name: agent.name, pending: tasks.length }); } catch {}
    }

    _sendFailures.delete(uid);

    // D2: schedule per-task timeout + retry for each pending task.
    // If the agent doesn't claim it within BOOS_TASK_TIMEOUT_MS, wake_agent
    // is retried up to 2 times; after 2 failures escalate to root inbox.
    for (const t of tasks) {
      _scheduleTaskTimeout(t.task_id, uid, 0);
    }

    // M4: Trigger wake_agent to ensure agent is actually woken up via PTY
    // This is the core of event-driven architecture:
    // - Task arrives → BOOS detects pending tasks → triggers wake_agent
    // - wake_agent sends PTY wake signal → agent wakes up → calls check_inbox
    // - Agent processes task → calls respond_task → task becomes completed
    console.log('[boos] _onTaskAvailable: triggering wakeAgent for', agent.name, 'with', tasks.length, 'pending tasks');
    const wakeResult = await wakeAgent(uid, { urgency: 'normal' });
    console.log('[boos] _onTaskAvailable: wakeAgent result:', wakeResult.ok ? 'success' : 'failed',
      'tasks_delivered:', wakeResult.tasks_delivered);

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

// ── A3: task claimed lifecycle event ──────────────────────────────────
// Fires when an agent picks up a task via check_inbox. Pushes SSE
// task_lifecycle event so the frontend task dashboard shows real-time
// status transitions (pending → in_progress).

async function _onTaskClaimed({ task_id, agent_uid, agent_name, sender_uid, priority, claimed_at }) {
  // Notify the receiver (claimer) — task is now in_progress.
  const match = await _findSessionByUid(agent_uid, agent_name, 'boos');
  if (match && _frontendNotify) {
    try {
      _frontendNotify(match.id, 'busy', {
        type: 'task_lifecycle',
        event: 'task_claimed',
        task_id,
        agent_uid,
        sender_uid,
        priority,
        claimed_at,
      });
    } catch {}
  }

  // Also notify the sender so they know the task is being worked on.
  if (sender_uid && _frontendNotify) {
    try {
      const sender = store.getAgent(sender_uid);
      if (sender) {
        const senderMatch = await _findSessionByUid(sender_uid, sender.name, sender.workspace);
        if (senderMatch) {
          _frontendNotify(senderMatch.id, 'idle', {
            type: 'task_lifecycle',
            event: 'task_claimed',
            task_id,
            claimed_by: agent_name,
            claimed_by_uid: agent_uid,
            claimed_at,
          });
        }
      }
    } catch {}
  }
}

// ── outbound notification: sender learns when task completes ─────────

async function _onTaskCompleted({ task_id, sender_uid, receiver_uid, receiver_name, result, metadata }) {
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

  // Sprint 16: no PTY write for task completion.
  // Sender sees completion via Agent Canvas SSE (frontend) + SSE transport (notifyAgent).
  // A3: push task_lifecycle events so Agent Canvas can show per-task completion state.
  // Sender (A) gets task_completed; receiver (B) gets task_done.
  if (_frontendNotify) {
    try {
      _frontendNotify(match.id, 'idle', {
        type: 'task_lifecycle',
        event: 'task_completed',
        task_id,
        receiver_uid, receiver_name,
        sender_uid,
        result_preview: (result || '').slice(0, 100),
        timestamp: new Date().toISOString(),
      });
    } catch {}
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

  // Wake the sender so they see the response immediately.
  // wakeAgent: SSE-first (silent, unblocks check_inbox(wait=true)),
  // PTY \r fallback only when SSE fails (idle sender with no active MCP session).
  try {
    await wakeAgent(sender_uid, {
      urgency: 'normal',
      message: `任务 #${task_id} 已被 ${receiver_name} 完成`,
    });
  } catch {}

  // D1: Push completion notification into sender's task inbox.
  // The sender sees this as a lightweight notification task when they call
  // check_inbox / list_my_tasks — no need to poll get_task(task_id).
  // reply_to links back to the original task for easy lookup.
  try {
    const notificationTask = {
      task_id: store.genTaskId(),
      sender_uid: receiver_uid || 'system',
      sender_name: receiver_name || '系统',
      sender_intro: '任务完成通知',
      receiver_uid: sender_uid,
      content: `任务已完成: "${(result || '').slice(0, 80)}"`,
      priority: 'normal',
      status: 'notification', // lightweight — doesn't need processing
      result: null,
      reply_to: task_id, // links back to original task
      required_capabilities: [],
      matched_via: 'notification',
      metadata: metadata || null, // Sprint 18: carry structured metadata
      created_at: new Date().toISOString(),
    };
    await store.insertTask(notificationTask);
  } catch (e) {
    console.warn('[boos] _onTaskCompleted: failed to create notification task:', e.message);
  }
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
  // ── Pass 0 (new): IdentityResolver canonical resolution ──
  try {
    const { getResolver } = require('../../identityResolver');
    const boosId = getResolver().canonical(uid);
    if (boosId) {
      const all = await persistedSessions.loadAll();
      const m = all.find((s) => s.id === boosId);
      if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
    }
  } catch { /* resolver unavailable → fall through */ }

  // ── Pass 1: identity card by UID → boos_session_id ──
  const id1 = store.getIdentity({ uid });
  if (id1?.boos_session_id) {
    const all = await persistedSessions.loadAll();
    const m = all.find((s) => s.id === id1.boos_session_id);
    if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
  }

  // ── Pass 1.5 (Sprint 16): auto-heal missing/sentinel boos_session_id ──
  // If identity exists but boos_session_id is null or sentinel, try to resolve
  // it now and fix the identity card so future lookups succeed.
  if (id1 && (!id1.boos_session_id || id1.boos_session_id === '__pending__' || id1.boos_session_id === '__unbound__')) {
    try {
      const resolved = await store.resolveBoosSessionForAgent(id1.name, id1.workspace);
      if (resolved) {
        await store.upsertIdentity(uid, { boos_session_id: resolved });
        console.log('[boos] identity auto-heal: linked', id1.name, '→', resolved);
        const all = await persistedSessions.loadAll();
        const m = all.find((s) => s.id === resolved);
        if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
      }
    } catch { /* auto-heal best-effort */ }
  }

  // ── Pass 2: identity card by name+workspace ──
  const id2 = store.getIdentity({ name: agentName, workspace });
  if (id2?.boos_session_id && id2.agent_uid !== uid) {
    const all = await persistedSessions.loadAll();
    const m = all.find((s) => s.id === id2.boos_session_id);
    if (m) { const t = webTerminal.get(m.id); if (t && !t.exitedAt) return m; }
  }
  // ── Pass 3: legacy heuristic fallback ──
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
//
// Sprint 13.4: Wake = auto-deliver all pending tasks with processing
// instructions. Agent processes until inbox empty, then sleeps.
// PM workflow: send_task → wake_agent (ensures delivery + action).

// \r = Enter key in raw terminal mode (CR). \n alone is just line-feed,
// which Claude Code's TUI does not interpret as submission.
const CORE_WAKE_COMMAND = 'check_inbox(wait=true)\r';

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const urgency = opts.urgency || 'normal';
  const tasksToDeliver = store.listActiveTasks(uid);

  console.log('[boos] wakeAgent: attempting to wake', agent.name, '(', uid, ') with', tasksToDeliver.length, 'tasks');

  // ── C3: SSE primary delivery path (works without PTY) ──────────
  // Push wake notification via SSE transport. This reaches agents
  // through their MCP SSE connection and unblocks check_inbox(wait=true).
  let sseDelivered = false;
  try {
    const { notifyAgent } = require('./transport');
    sseDelivered = notifyAgent(uid, 'notifications/agent_bus/wake', {
      uid, agent_name: agent.name, workspace: agent.workspace,
      pending: tasksToDeliver.length,
      task_ids: tasksToDeliver.map((t) => t.task_id),
      urgency,
      message: (opts.message || '').slice(0, 256),
      timestamp: new Date().toISOString(),
    });
    if (sseDelivered) {
      console.log('[boos] wakeAgent: SSE delivered to', agent.name);
    }
  } catch (e) {
    console.warn('[boos] wakeAgent: SSE notify failed for', agent.name, e.message);
  }

  // ── PTY fallback delivery path (only when SSE failed) ──
  // SSE is the primary agent-bus channel. PTY \r injection is a last-resort
  // fallback for agents without an active SSE connection.  When SSE succeeds
  // the agent is already unblocked; writing \r would only pollute their
  // terminal with stale commands.
  let ptyWritten = false;
  const match = await _findSessionByUid(uid, agent.name, agent.workspace);
  if (!sseDelivered && match) {
    const term = webTerminal.get(match.id);
    if (term && !term.exitedAt) {
      try {
        _writeToPty(match.id, CORE_WAKE_COMMAND);
        ptyWritten = true;
        console.log('[boos] wakeAgent: PTY fallback injected to', agent.name,
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

  // Track delivery + push frontend event.
  _lastWake.set(uid, Date.now());
  _pendingQueues.delete(uid);
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
    sse_delivered: sseDelivered,
    pty_delivered: ptyWritten,
  };
}

// Sprint 10 R11: Notify receiver that their task has been interrupted/preempted.
// Pushes PTY message + SSE status update so the agent drops current work.
async function _onTaskInterrupted(taskId, receiverUid, receiverName, taskContent) {
  const match = await _findSessionByUid(receiverUid, receiverName, 'boos');
  if (!match) return;

  const preview = (taskContent || '').split('\n')[0].slice(0, 80);
  // Sprint 16: no PTY write for interrupt notification.
  // Agent sees status change via SSE frontend (Agent Canvas).
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

// M3: Check all pending queues and return list of agent UIDs with pending tasks
function checkAllQueues() {
  // Refresh the pending queues set by checking each agent
  _pendingQueues.clear();
  const allAgents = store.listAllAgents();
  for (const agent of allAgents) {
    const pendingCount = store.countPendingTasks(agent.uid);
    if (pendingCount > 0) {
      _pendingQueues.add(agent.uid);
    }
  }
  return Array.from(_pendingQueues);
}

// M3: Check if a specific agent has pending tasks
function hasPendingTasks(uid) {
  return store.countPendingTasks(uid) > 0;
}

// D2: Per-task timeout detection + auto retry + escalation to PM inbox.
// When a task is sent (task_available event), a timeout is scheduled. If the
// task is still pending after BOOS_TASK_TIMEOUT_MS, wake_agent is retried.
// After 2 retries with no response, the task is cancelled and escalated to
// the root/PM inbox via send_to_root.
//
// Configurable via env vars:
//   BOOS_TASK_TIMEOUT_MS    — per-retry timeout (default 120s)
//   BOOS_TASK_MAX_RETRIES   — max wake_agent retries before escalation (default 2)

const TASK_TIMEOUT_MS = parseInt(process.env.BOOS_TASK_TIMEOUT_MS, 10) || 120_000;
const TASK_MAX_RETRIES = parseInt(process.env.BOOS_TASK_MAX_RETRIES, 10) || 2;
const _taskTimeouts = new Map(); // task_id → { timer, task_id, receiver_uid, retry_count }

function _scheduleTaskTimeout(taskId, receiverUid, retryCount) {
  // Cancel any existing timeout for this task.
  _cancelTaskTimeout(taskId);

  const timer = setTimeout(async () => {
    _taskTimeouts.delete(taskId);
    try {
      const task = store.getTask(taskId);
      if (!task) return;

      // Task already resolved (completed, cancelled, exhausted) — stop tracking.
      if (!['pending', 'blocked'].includes(task.status)) return;

      const agent = store.getAgent(receiverUid);
      const agentName = agent?.name || '(unknown)';

      console.log('[boos] task-timeout:', taskId, 'still pending after retry', retryCount,
        '/', TASK_MAX_RETRIES, '→ agent', agentName);

      if (retryCount < TASK_MAX_RETRIES) {
        // Retry: wake_agent again.
        console.log('[boos] task-timeout: retrying wake_agent for', agentName);
        await wakeAgent(receiverUid, { urgency: 'urgent' });
        _scheduleTaskTimeout(taskId, receiverUid, retryCount + 1);
      } else {
        // Escalate: mark cancelled, notify root/PM.
        console.log('[boos] task-timeout: escalating task', taskId, 'to root after', TASK_MAX_RETRIES, 'retries');
        await store.cancelTaskAtomic(taskId, null, { supervisor: true });

        // D2: escalate to root inbox via send_to_root.
        try {
          const senderName = task.sender_name || (store.getAgent(task.sender_uid)?.name || '系统');
          const escalatedContent = [
            '## 任务超时升级 — 接收方无响应',
            '',
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

          const { sendToRoot } = require('./handlers');
          if (typeof sendToRoot === 'function') {
            await sendToRoot({ content: escalatedContent }, { uid: 'system', name: 'BOOS Timeout', workspace: 'boos' });
          } else {
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
          }
        } catch (e) {
          console.warn('[boos] task-timeout: escalation failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[boos] task-timeout: error in timeout handler for', taskId, e.message);
    }
  }, TASK_TIMEOUT_MS);
  timer.unref();

  _taskTimeouts.set(taskId, { timer, task_id: taskId, receiver_uid: receiverUid, retry_count: retryCount });
}

function _cancelTaskTimeout(taskId) {
  const entry = _taskTimeouts.get(taskId);
  if (entry) {
    clearTimeout(entry.timer);
    _taskTimeouts.delete(taskId);
  }
}

// Public: cancel timeout tracking for a task (e.g. when task is claimed or completed).
function cancelTaskTimeoutTracking(taskId) {
  _cancelTaskTimeout(taskId);
}

// D2: export for handlers.js — cancel timeout when agent claims task via check_inbox.
function onTaskClaimed(taskId) {
  _cancelTaskTimeout(taskId);
}

module.exports = {
  start,
  stop,
  wakeAgent,
  setFrontendNotify,
  _onTaskInterrupted,
  checkAllQueues,  // M3: New API for scanning pending queues
  hasPendingTasks, // M3: New API for checking agent pending status
  // D2: task timeout + retry management
  onTaskClaimed,             // cancel timeout when agent claims task
  cancelTaskTimeoutTracking, // manual cancel
  _scheduleTaskTimeout,      // used by _onTaskAvailable to start tracking
};

// BOOS → Agent-Bus in-process push notification bridge.
//
// Architecture (Sprint 16): Agent-to-agent communication flows exclusively
// through SSE transport. PTY is reserved for human ↔ CLI interaction only.
//
//   send_task → inboxEvents('task_available') → mark in_progress → SSE notifyAgent()
//        ↓ transport.js pushes to agent's MCP SSE connection
//   Agent: check_inbox() returns immediately → process or sleep
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
        const match = await _findSessionByUid(sup.uid);
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
        const sm = await _findSessionByUid(task.sender_uid);
        if (sm) _writeToPty(sm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id
          + ': 超过24h已归档 → ' + archivePath + '\r\n');
      }
      // Notify receiver.
      const recvAg = store.getAgent(task.receiver_uid);
      if (recvAg) {
        const rm = await _findSessionByUid(task.receiver_uid);
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
  let match = await _findSessionByUid(uid);
  if (!match) {
    // Supervisor agents are human-operated — NEVER auto-launch a session for them.
    // Their sessions are started manually and may not have agentUid bound yet
    // (sessionBinding is async). Auto-launching creates a phantom window.
    if (agent.role === 'supervisor') {
      console.log('[boos] _onTaskAvailable: supervisor', agent.name, 'has no bound session — SSE-only delivery');
      // Fall through to SSE delivery below (match stays null, PTY path skipped).
    } else {
      // Worker agent is registered but has no live session — try to wake.
      const attempts = _wakeAttempts.get(uid) || 0;
      if (attempts < MAX_WAKE_ATTEMPTS) {
        _wakeAttempts.set(uid, attempts + 1);
        console.log('[boos] wake-before-deliver: launching session for', agent.name, '(attempt ' + (attempts + 1) + ')');
        try {
          const { _internalLaunchAgentSession } = require('./handlers');
          await _internalLaunchAgentSession(uid, agent.name, agent.workspace);
          match = await _findSessionByUid(uid);      } catch (e) {
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
  }

  // Supervisor without a bound session: SSE-only delivery path.
  // Don't crash on match.id — match is null for unbound supervisors.
  if (!match) {
    // SSE delivery still works (MCP SSE connection is session-independent).
    const tasks = store.listPendingTasks(uid);
    if (tasks.length > 0) {
      _pendingQueues.add(uid);
      try {
        const { notifyAgent } = require('./transport');
        notifyAgent(uid, 'notifications/agent_bus/inbox_updated', {
          uid, agent_name: agent.name, workspace: agent.workspace,
          pending: tasks.length,
          task_ids: tasks.map((t) => t.task_id),
        });
      } catch {}
      for (const t of tasks) {
        _scheduleTaskTimeout(t.task_id, uid, 0);
      }
    }
    console.log('[boos] _onTaskAvailable: supervisor', agent.name, 'notified via SSE only (no bound PTY session)');
    return;
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
  const match = await _findSessionByUid(agent_uid);
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
        const senderMatch = await _findSessionByUid(sender_uid);
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

  // Sprint 21: Root agent completion — push SSE transport to receiver + frontend.
  // Event-driven: agent gets SSE notification immediately, no need to poll check_root_response.
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
    // Push SSE transport notification to the agent who requested root action.
    try {
      const { notifyAgent } = require('./transport');
      notifyAgent(receiver_uid, 'notifications/agent_bus/root_response', {
        task_id,
        result_preview: (result || '').slice(0, 200),
        receiver_uid,
        timestamp: new Date().toISOString(),
      });
    } catch {}
    return;
  }

  const agent = store.getAgent(sender_uid);
  if (!agent) { _logDeliveryFailure(sender_uid, '(unknown)', 'agent record not found'); return; }

  const match = await _findSessionByUid(sender_uid);
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
        const recvMatch = await _findSessionByUid(receiver_uid);
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
  // wakeAgent: SSE-first (silent notification), PTY \r injection as fallback.
  // Both channels deliver "check_inbox(wait=false)" — agent checks inbox
  // immediately, processes what's there, then sleeps if empty.
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

// Sprint 22: single-path session lookup via persistedSessions.agentUid.
// No more identity-card indirection, heuristics, or sentinel auto-heal.
// All session writes go through writeIdentity() which keeps agentUid in sync.
// See _findSessionByUid() below.

async function _findSessionByUid(uid) {
  const all = await persistedSessions.loadAll();
  const match = all.find((s) => s.agentUid === uid && s.status === 'running');
  if (match) {
    const term = webTerminal.get(match.id);
    if (term && !term.exitedAt) return match;
  }
  return null;
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

// PTY submit semantics (Sprint 20 fix):
//
// Claude Code's TUI (Ink-based) reads raw stdin. Enter/submit is CR (0x0D).
// The old wake string embedded prose + a mid-string "\n" before the command:
//   "[agent-bus] PM 唤醒你\ncheck_inbox(wait=false)\r"
// That mid-string \n flipped the input box into multi-line editing mode, so
// the trailing \r was treated as *another* soft newline instead of a submit.
// Result: the command sat in the input, never executed — the "无法自动注入
// 回车" bug.
//
// Fix: inject ONLY the bare single-line command (no prose, no embedded \n),
// then send a lone CR as a SEPARATE write after a short delay so Ink's input
// handler processes the pasted text before the Enter keystroke arrives.
// Sender identity is carried on the SSE payload + frontend Agent Canvas, so
// the terminal doesn't need the prose line.
const WAKE_COMMAND = 'check_inbox';
const PTY_SUBMIT_DELAY_MS = parseInt(process.env.BOOS_PTY_SUBMIT_DELAY_MS, 10) || 120;

// Inject a command into a Claude Code TUI PTY and submit it.
// Two-phase: (1) write the command text, (2) after PTY_SUBMIT_DELAY_MS, write
// a lone CR (0x0D = Enter). Splitting the submit into its own write is what
// makes auto-submit reliable — a single combined "text\r" write often has its
// trailing CR swallowed or coalesced by the TUI's input debouncer.
async function _injectCommand(sessionId, command) {
  _writeToPty(sessionId, command);
  await new Promise((r) => setTimeout(r, PTY_SUBMIT_DELAY_MS));
  _writeToPty(sessionId, '\r');
}

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const urgency = opts.urgency || 'normal';
  const tasksToDeliver = store.listActiveTasks(uid);

  console.log('[boos] wakeAgent: attempting to wake', agent.name, '(', uid, ') with', tasksToDeliver.length, 'tasks');

  // ── C3: SSE primary delivery path (works without PTY) ──────────
  // Push wake notification via SSE transport. This reaches agents
  // through their MCP SSE connection — the agent sees the wake event
  // and calls check_inbox(wait=false) to pick up pending tasks.
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
    if (sseDelivered) {
      console.log('[boos] wakeAgent: SSE delivered to', agent.name);
    }
  } catch (e) {
    console.warn('[boos] wakeAgent: SSE notify failed for', agent.name, e.message);
  }

  // ── PTY activation path (always attempted alongside SSE) ──
  // SSE delivery notifies an agent with an active MCP SSE connection.
  // If the agent is idle (check_inbox returned empty and CC is waiting for input),
  // SSE notification may be silently dropped. PTY \r injection is the fallback:
  // it types "check_inbox(wait=false)" and presses Enter, submitting it as a new
  // Claude Code message to wake the agent.
  // Both channels fire independently; the agent handles duplicate wake-ups safely.
  let ptyWritten = false;
  const match = await _findSessionByUid(uid);
  if (match) {
    const term = webTerminal.get(match.id);
    if (term && !term.exitedAt) {
      try {
        // Two-phase inject: bare single-line command, then a separate CR.
        // Sender identity travels on the SSE payload above, not the PTY text.
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
  const match = await _findSessionByUid(receiverUid);
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
//   BOOS_TASK_TIMEOUT_MS    — per-retry timeout (default 24h)
//   BOOS_TASK_MAX_RETRIES   — max wake_agent retries before escalation (default 0)

const TASK_TIMEOUT_MS = parseInt(process.env.BOOS_TASK_TIMEOUT_MS, 10) || 86_400_000;
const TASK_MAX_RETRIES = parseInt(process.env.BOOS_TASK_MAX_RETRIES, 10) || 0;
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

// ── Sprint 24: TeamCompact — milestone-triggered full-team /compact ───────

const COMPACT_COMMAND = '/compact';

async function compactAllWorkers(workspace, { milestone, note } = {}) {
  const allAgents = store.listAllAgents();
  const workers = allAgents.filter((a) =>
    a.workspace === workspace &&
    a.role !== 'supervisor' &&
    a.uid
  );
  if (workers.length === 0) {
    return { ok: false, error: 'no worker agents found in workspace ' + workspace };
  }

  // Gate 2: verify all workers idle (no in_progress tasks).
  const busyWorkers = [];
  for (const w of workers) {
    const active = store.listActiveTasks(w.uid);
    if (active.some((t) => t.status === 'in_progress')) {
      busyWorkers.push({ uid: w.uid, name: w.name, active: active.filter((t) => t.status === 'in_progress').length });
    }
  }
  if (busyWorkers.length > 0) {
    return {
      ok: false, error: 'agents still busy',
      busy: busyWorkers.map((b) => b.name + ' (' + b.active + ' tasks)'),
    };
  }

  // Gate 3: ensure all workers have active PTY.
  const results = [];
  for (const w of workers) {
    const match = await _findSessionByUid(w.uid);
    if (!match) { results.push({ uid: w.uid, name: w.name, compacted: false, error: 'no PTY session' }); continue; }
    const term = webTerminal.get(match.id);
    if (!term || term.exitedAt) { results.push({ uid: w.uid, name: w.name, compacted: false, error: 'PTY exited' }); continue; }
    try {
      await _injectCommand(match.id, COMPACT_COMMAND);
      results.push({ uid: w.uid, name: w.name, compacted: true, session_id: match.id });
      console.log('[boos] TeamCompact: /compact injected to', w.name);
    } catch (e) {
      results.push({ uid: w.uid, name: w.name, compacted: false, error: e.message });
    }
  }

  const compacted = results.filter((r) => r.compacted).length;
  return {
    ok: true, compacted, total: workers.length,
    milestone: milestone || null, note: note || null,
    agents: results,
    hint: compacted === workers.length
      ? 'All ' + compacted + ' agents compacted.'
      : compacted + '/' + workers.length + ' agents compacted (' + results.filter((r) => !r.compacted).length + ' failures).',
  };
}

module.exports = {
  start,
  stop,
  wakeAgent,
  compactAllWorkers,
  setFrontendNotify,
  _onTaskInterrupted,
  checkAllQueues,  // M3: New API for scanning pending queues
  hasPendingTasks, // M3: New API for checking agent pending status
  // D2: task timeout + retry management
  onTaskClaimed,             // cancel timeout when agent claims task
  cancelTaskTimeoutTracking, // manual cancel
  _scheduleTaskTimeout,      // used by _onTaskAvailable to start tracking
};

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

let _hrAgentUid = null;

const DEBOUNCE_MS = 30000;

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
      const allSessions = await persistedSessions.loadAll();
      const supervisors = store.listAgentsInWorkspace(ws).filter((a) => a.role === 'supervisor');
      for (const sup of supervisors) {
        const match = _findSession(allSessions, sup.name, sup.workspace);
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

  // Sprint 8 #61: task timeout scanner — cancels tasks stuck > 30 min.
  taskTimeout.start(store, async (task) => {
    try {
      const allSessions = await persistedSessions.loadAll();
      // Notify sender.
      const senderAg = store.getAgent(task.sender_uid);
      if (senderAg) {
        const sm = _findSessionByUid(allSessions, task.sender_uid, senderAg.name, senderAg.workspace);
        if (sm) _writeToPty(sm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id + ': 已自动取消（30分钟无响应）\n');
      }
      // Notify receiver.
      const recvAg = store.getAgent(task.receiver_uid);
      if (recvAg) {
        const rm = _findSessionByUid(allSessions, task.receiver_uid, recvAg.name, recvAg.workspace);
        if (rm) _writeToPty(rm.id, '\n[agent-bus] ⏰ 任务超时 #' + task.task_id + ': 你未在30分钟内响应\n');
      }
    } catch {}
  });

  console.log('[boos] agent-bus in-process push notifications active (in+out)');
}

function stop() {
  if (!_started) return;
  _started = false;
  queue.inboxEvents.removeListener('task_available', _onTaskAvailable);
  queue.outboxEvents.removeListener('task_completed', _onTaskCompleted);
}

async function _onTaskAvailable(uid) {
  // Debounce: max one delivery per agent per 30s.
  const last = _lastWake.get(uid) || 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  _lastWake.set(uid, Date.now());

  const agent = store.getAgent(uid);
  if (!agent) return;

  // Find matching BOOS session — try agent-bus sessions table first.
  const allSessions = await persistedSessions.loadAll();
  const match = _findSessionByUid(allSessions, uid, agent.name, agent.workspace);
  if (!match) { _logDeliveryFailure(uid, agent.name, 'no running BOOS session'); return; }

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) { _logDeliveryFailure(uid, agent.name, 'PTY not available'); return; }

  // Deliver ALL pending tasks directly — no manual check_inbox needed.
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
    // Auto-claim: mark all pending tasks as in_progress on delivery.
    for (const t of tasks) {
      store.updateTaskStatus(t.task_id, 'in_progress', null);
    }
    const claimLines = tasks.map((t) => `[agent-bus] 📨 任务已自动认领 #${t.task_id}`);
    lines.push(claimLines.join('\n'));
    _writeToPty(match.id, lines.join('') + '\n');
  } catch {}
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

async function _onTaskCompleted({ task_id, sender_uid, receiver_name, result }) {
  const agent = store.getAgent(sender_uid);
  if (!agent) { _logDeliveryFailure(sender_uid, '(unknown)', 'agent record not found'); return; }

  const allSessions = await persistedSessions.loadAll();
  const match = _findSessionByUid(allSessions, sender_uid, agent.name, agent.workspace);
  if (!match) { _logDeliveryFailure(sender_uid, agent.name, 'no running BOOS session'); return; }

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) { _logDeliveryFailure(sender_uid, agent.name, 'PTY not available'); return; }

  const preview = (result || '').split('\n')[0].slice(0, 80);
  const msg = `\n[agent-bus] ✅ ${receiver_name} 完成 #${task_id}: ${preview}\n`;
  try {
    webTerminal.write(match.id, msg);
  } catch {}
}

function _findSession(sessions, agentName, workspace) {
  const running = sessions.filter((s) => s.status === 'running' && s.cwd);

  // Pass 0: direct agent-bus sessions lookup by agent UID (most reliable).
  // If the agent registered via MCP, their session is in the sessions table.
  // We try this inside _findSessionByUid which is called first by callers.
  // (Pass 0 is handled by _findSessionByUid, not here — see below.)

  // Pass 1: exact match on cwd basename === agent name AND workspace matches.
  const exact = running.filter((s) =>
    path.basename(s.cwd) === agentName && s.workspace === workspace,
  );
  if (exact.length > 0) return exact[0];

  // Pass 2: cwd basename matches agent name.
  const nameMatch = running.filter((s) => path.basename(s.cwd) === agentName);
  if (nameMatch.length > 0) return nameMatch[0];

  // Pass 3: fuzzy substring match (case-insensitive).
  const agentLower = agentName.toLowerCase();
  const wsLower = (workspace || '').toLowerCase();
  const fuzzy = running.filter((s) => {
    const cwdLower = s.cwd.toLowerCase();
    return cwdLower.includes(agentLower) && (wsLower ? cwdLower.includes(wsLower) : true);
  });
  if (fuzzy.length > 0) return fuzzy[0];

  return null;
}

// Primary session lookup: try agent-bus sessions table first (by UID),
// then fall back to name-based matching.
function _findSessionByUid(sessions, uid, agentName, workspace) {
  // Pass 0: direct agent-bus sessions lookup by agent UID.
  const agentSessionId = store.getSessionByAgentUid(uid);
  if (agentSessionId) {
    const match = sessions.find((s) => s.id === agentSessionId && s.status === 'running');
    if (match) return match;
  }
  // Fall back to name-based matching.
  return _findSession(sessions, agentName, workspace);
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

  const allSessions = await persistedSessions.loadAll();
  const match = _findSessionByUid(allSessions, uid, agent.name, agent.workspace);
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
    // Track last wake for debounce-aware callers (but we always fire)
    _lastWake.set(uid, Date.now());
    return { ok: true, agent_uid: uid, agent_name: agent.name, session_id: match.id, urgency };
  } catch (e) {
    return { ok: false, error: 'PTY write failed: ' + e.message };
  }
}

module.exports = { start, stop, wakeAgent };

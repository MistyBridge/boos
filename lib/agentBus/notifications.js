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
const persistedSessions = require('../persistedSessions');
const webTerminal = require('../webTerminal');

const DEBOUNCE_MS = 30000;

let _started = false;
const _lastWake = new Map();

function start() {
  if (_started) return;
  _started = true;

  queue.inboxEvents.on('task_available', _onTaskAvailable);
  console.log('[boos] agent-bus in-process push notifications active');
}

function stop() {
  if (!_started) return;
  _started = false;
  queue.inboxEvents.removeListener('task_available', _onTaskAvailable);
}

async function _onTaskAvailable(uid) {
  // Debounce: max one delivery per agent per 30s.
  const last = _lastWake.get(uid) || 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  _lastWake.set(uid, Date.now());

  const agent = store.getAgent(uid);
  if (!agent) return;

  // Find matching BOOS session.
  const allSessions = await persistedSessions.loadAll();
  const match = _findSession(allSessions, agent.name, agent.workspace);
  if (!match) return;

  const term = webTerminal.get(match.id);
  if (!term || term.exitedAt) return;

  // Deliver ALL pending tasks directly — no manual check_inbox needed.
  const tasks = store.listPendingTasks(uid);
  if (tasks.length === 0) return;

  try {
    const lines = tasks.map((t) => {
      const sender = t.sender_name || 'unknown';
      const prio = t.priority === 'high' ? '🔴' : t.priority === 'urgent' ? '⚡' : '';
      const header = prio ? `[agent-bus] ${prio} ${sender}:` : `[agent-bus] 📨 ${sender}:`;
      return `\n${header}\n${t.content}\n`;
    });
    _writeToPty(match.id, lines.join('') + '\n');
  } catch {}
}

function _findSession(sessions, agentName, workspace) {
  const running = sessions.filter((s) => s.status === 'running' && s.cwd);

  // Pass 1: exact match on cwd basename === agent name AND workspace matches.
  const exact = running.filter((s) =>
    path.basename(s.cwd) === agentName && s.workspace === workspace
  );
  if (exact.length > 0) return exact[0];

  // Pass 2: cwd basename matches agent name.
  const nameMatch = running.filter((s) => path.basename(s.cwd) === agentName);
  if (nameMatch.length > 0) return nameMatch[0];

  // Pass 3: fuzzy substring match.
  const fuzzy = running.filter((s) =>
    s.cwd.includes(agentName) && s.cwd.includes(workspace)
  );
  if (fuzzy.length > 0) return fuzzy[0];

  return null;
}

function _writeToPty(sessionId, data) {
  const sessions = webTerminal._sessions;
  const entry = sessions ? sessions.get(sessionId) : null;
  if (entry && entry.pty && !entry.exitedAt) {
    entry.pty.write(data);
  }
}

// ── Wake agent on demand (bypasses debounce) ──────────────────────────
// Called by the wake_agent MCP tool. Unlike the automatic 0→1 inbox
// notification (which is debounced 30s), this fires immediately every
// time to support on-demand cross-agent wake-up.

async function wakeAgent(uid, opts = {}) {
  const agent = store.getAgent(uid);
  if (!agent) return { ok: false, error: 'agent not found: ' + uid };

  const allSessions = await persistedSessions.loadAll();
  const match = _findSession(allSessions, agent.name, agent.workspace);
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

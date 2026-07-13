// BOOS → Agent-Bus in-process push notification bridge.
//
// Replaces lib/agentBusWatcher.js. Instead of connecting to an external
// agent-bus process via SSE, this listens directly to queue.inboxEvents
// (EventEmitter) within the same process.
//
// Flow:
//   queue.sendTask → 0→1 inbox transition
//        ↓ queue.inboxEvents.emit('task_available', uid)
//   notifications.js: resolve uid → BOOS session → PTY
//        ↓ pty.write()
//   Claude agent: receives [agent-bus] message → calls check_inbox → gets task

'use strict';

const path = require('path');
const queue = require('./queue');
const store = require('./store');
const persistedSessions = require('../persistedSessions');
const webTerminal = require('../webTerminal');

const DEBOUNCE_MS = 30000;

const WAKE_MESSAGE = '\n[agent-bus] 你有新的协作任务到达收件箱。请调用 check_inbox 获取。\n';

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
  // Debounce: max one wake per agent per 30s.
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

  try {
    _writeToPty(match.id, WAKE_MESSAGE);
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

module.exports = { start, stop };

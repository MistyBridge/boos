// PTY Injection Queue — per-agent FIFO + event-driven drain.
//
// Sprint N: All PTY writes route through this module.  enqueue() only adds
// to the queue; drainIfIdle() is the sole injection path.  Drain is driven
// by busy→idle transitions (task completion, cancellation, etc.) — no
// polling timers.  A draining flag prevents concurrent injection while
// waiting for the agent to consume the last command.
//
// Flow:
//   enqueue(uid, text)  → push to queue → drainIfIdle (initial kick)
//   busy→idle hook      → releaseAndDrain
//   drainIfIdle         → check state → shift 1 → inject PTY → gate up
//
// All requires of notificationsWake are deferred (inside function bodies)
// to avoid circular dependency: notificationsWake → ptyInjectionQueue
// and ptyInjectionQueue → notificationsWake.

'use strict';

const store = require('./store');
const collaborationLoop = require('./collaborationLoop');

// ── per-agent queue ──────────────────────────────────────────────────────
// Map<uid, { queue: string[], draining: boolean }>
const _queues = new Map();

// ── deferred helpers (avoid circular require at module-load time) ────────

function _findSessionByUid(uid) {
  return require('./notificationsWake')._findSessionByUid(uid);
}

function _injectCommand(sessionId, command) {
  return require('./notificationsWake')._injectCommand(sessionId, command);
}

function _autoResumeSession(uid) {
  const m = require('./notificationsWake');
  if (typeof m._autoResumeSession === 'function') {
    return m._autoResumeSession(uid);
  }
  return null;
}

async function _getSessionForAgent(uid) {
  const session = await _findSessionByUid(uid);
  if (session) return session;
  return await _autoResumeSession(uid);
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Enqueue a PTY injection for an agent.  Does NOT inject — only adds to
 * the queue.  Calls drainIfIdle() as the initial kick; subsequent drain
 * is driven by busy→idle hooks via releaseAndDrain().
 */
async function enqueue(uid, text) {
  if (!uid || !text) return { ok: false, error: 'uid and text are required' };

  // Strip trailing \r / \n — _injectCommand appends its own \n\r.
  const cleaned = text.replace(/[\r\n]+$/, '');

  let entry = _queues.get(uid);
  if (!entry) {
    entry = { queue: [], draining: false };
    _queues.set(uid, entry);
  }
  entry.queue.push(cleaned);

  console.log('[ptyQueue] enqueued for', uid.slice(-8),
    '(len=' + entry.queue.length + ')', '"' + cleaned.slice(0, 60) + '"');

  // Initial kick — if agent is idle, this injects immediately.
  await drainIfIdle(uid);

  return { ok: true, queued: true, queue_length: entry.queue.length };
}

/**
 * Attempt to drain one item from the agent's queue.
 * Only injects if: gate is open, agent is idle, and PTY is available.
 *
 * Sprint 38 fix: set entry.draining = true BEFORE any async operations.
 * The old code set it AFTER await getAgentState — creating a race window
 * where multiple concurrent drainIfIdle() calls could all pass the gate
 * check before any one reached the assignment.  Now the first caller to
 * grab the gate owns it; all others are blocked until releaseAndDrain().
 */
async function drainIfIdle(uid) {
  const entry = _queues.get(uid);
  if (!entry) return;
  if (entry.queue.length === 0) {
    _queues.delete(uid);
    return;
  }

  // Gate: prevent concurrent injection — set draining BEFORE any async ops.
  if (entry.draining) return;
  entry.draining = true;

  // Check agent busy/idle state (derived from inbox in_progress count).
  let state;
  try {
    state = await collaborationLoop.getAgentState(uid);
  } catch {
    entry.draining = false; // release gate on error
    return;
  }
  if (state.state !== 'idle') {
    entry.draining = false; // agent busy — retry on next releaseAndDrain
    return;
  }

  // Dequeue one item.
  const text = entry.queue.shift();
  if (!text) {
    _queues.delete(uid);
    return;
  }

  // Resolve PTY session.
  let session;
  try { session = await _getSessionForAgent(uid); } catch { /* defer */ }
  if (!session) {
    // No PTY — discard this injection (best-effort delivery signal).
    // The agent will discover pending tasks when they check_inbox.
    console.log('[ptyQueue] no PTY for', uid.slice(-8), '— discarding injection');
    entry.draining = false; // release gate
    if (entry.queue.length === 0) _queues.delete(uid);
    return;
  }

  // Inject.
  try {
    _injectCommand(session.id, text);
    // gate stays up — wait for busy→idle transition via releaseAndDrain
    console.log('[ptyQueue] injected to', uid.slice(-8),
      '(remaining=' + entry.queue.length + ')', '"' + text.slice(0, 60) + '"');
  } catch (e) {
    console.warn('[ptyQueue] injection failed for', uid.slice(-8), e.message);
    entry.draining = false; // release gate on failure
    if (entry.queue.length === 0) _queues.delete(uid);
  }
}

/**
 * Release the drain gate + attempt drain.
 * Called from busy→idle transition hooks (queue.js respondTask, etc.).
 */
async function releaseAndDrain(uid) {
  const entry = _queues.get(uid);
  if (!entry) return;
  entry.draining = false;
  await drainIfIdle(uid);
}

function getQueueLength(uid) {
  const entry = _queues.get(uid);
  return entry ? entry.queue.length : 0;
}

function clearQueue(uid) {
  const entry = _queues.get(uid);
  if (entry) {
    console.log('[ptyQueue] clearing queue for', uid.slice(-8),
      '(' + entry.queue.length + ' items discarded)');
  }
  _queues.delete(uid);
}

function cancelAll() {
  for (const uid of _queues.keys()) {
    _queues.delete(uid);
  }
  console.log('[ptyQueue] all queues cleared');
}

module.exports = {
  enqueue,
  drainIfIdle,
  releaseAndDrain,
  getQueueLength,
  clearQueue,
  cancelAll,
};

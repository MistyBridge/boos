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
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const store = require('./store');
const collaborationLoop = require('./collaborationLoop');

// ── per-agent queue ──────────────────────────────────────────────────────
// Map<uid, { queue: string[], draining: boolean, retries: number, _timer: NodeJS.Timeout|null }>
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
  const errReport = require("../errorReport");
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
    // Sprint 42: PTY injection retry with backoff.
    // When the PTY is not yet available (agent starting, auto-resume in
    // progress), don't discard — retry with backoff (30s → 2min → 5min).
    // After 3 attempts, give up and log the failure.
    entry.retries = (entry.retries || 0) + 1;
    const MAX_RETRIES = 3;
    if (entry.retries > MAX_RETRIES) {
      console.log('[ptyQueue] PTY not found for', uid.slice(-8),
        'after', MAX_RETRIES, 'retries — discarding injection');
      errReport.report('ptyQueue', 'noPTY',
        new Error(`PTY not found after ${MAX_RETRIES} retries for ${uid.slice(-8)}: "${text.slice(0, 80)}"`));
      if (entry._timer) { clearTimeout(entry._timer); entry._timer = null; }
      entry.retries = 0;
      entry.draining = false;
      if (entry.queue.length === 0) _queues.delete(uid);
      return;
    }
    // Put item back at front of queue for retry.
    entry.queue.unshift(text);
    const delays = [30000, 120000, 300000]; // 30s, 2min, 5min
    const delay = delays[entry.retries - 1] || 300000;
    console.log('[ptyQueue] no PTY for', uid.slice(-8),
      `— retry ${entry.retries}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
    entry.draining = false;
    const retryUid = uid;
    // Cancel any previous pending retry timer before scheduling a new one.
    if (entry._timer) { clearTimeout(entry._timer); entry._timer = null; }
    entry._timer = setTimeout(() => {
      entry._timer = null;
      console.log('[ptyQueue] retry drain for', retryUid.slice(-8), `(attempt ${entry.retries})`);
      drainIfIdle(retryUid);
    }, delay);
    // unref: the retry must not hold the process open (tests/scripts exit
    // even when an injection is pending for a session that never comes up).
    if (entry._timer.unref) entry._timer.unref();
    return;
  }

  // PTY found — reset retry count on successful resolution.
  if (entry.retries) {
    console.log('[ptyQueue] PTY resolved for', uid.slice(-8), `after ${entry.retries} retries`);
    entry.retries = 0;
  }

  // Inject.  If the session was just auto-resumed, _autoResumeSession already
  // waited 8s for Claude Code to initialise (MCP, agent-bus SSE, Ink TUI).
  // The PTY is ready — inject immediately.
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
    if (entry._timer) { clearTimeout(entry._timer); entry._timer = null; }
    console.log('[ptyQueue] clearing queue for', uid.slice(-8),
      '(' + entry.queue.length + ' items discarded)');
  }
  _queues.delete(uid);
}

function cancelAll() {
  for (const [uid, entry] of _queues) {
    if (entry._timer) { clearTimeout(entry._timer); entry._timer = null; }
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

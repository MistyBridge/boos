// Sleep/Wake Manager — Sprint 31 Phase 6.
//
// Manages agent sleep/wake lifecycle via PTY command injection.
// Integration: handlersDag._dagSleepAgent → sleepManager.sleep()
//              handlersDag._dagWakeAgent → sleepManager.wake()
//
// Design constraints:
//   - Leaf module — requires store + notificationsWake (already a leaf).
//   - Only workers can be put to sleep (PM/PMO are protected).
//   - Auto-wake timer fires after configurable minutes (default 5).
//   - Sleep state is in-memory only (reset on server restart).

'use strict';

const store = require('./store');
const { _findSessionByUid, _injectCommand } = require('./notificationsWake');

// ── commands ─────────────────────────────────────────────────────────────

const COMPACT_CMD = '/compact';
const WAKE_CMD = 'check_inbox';

// ── sleep state (in-memory) ──────────────────────────────────────────────

const _sleepState = new Map(); // uid → { since, wakeAt, wakeAfterMinutes, timer }

// ── helpers ──────────────────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

function _wakeAfterMs(minutes) {
  return Math.max(1, Math.min(minutes, 1440)) * 60 * 1000; // clamp 1–1440 min
}

// ── sleep ────────────────────────────────────────────────────────────────

/**
 * Put an agent to sleep. Injects /compact into their PTY and schedules
 * an auto-wake timer.
 *
 * Rules:
 *   - Only role='worker' agents can be slept.
 *   - PM/PMO cannot be put to sleep by anyone.
 *   - Already-sleeping agents: timer is reset.
 *
 * @param {string} targetUid
 * @param {{ wakeAfterMinutes?: number }} opts
 * @returns {{ ok, uid, name, sleeping, wake_at, wake_after_minutes }}
 */
async function sleep(targetUid, { wakeAfterMinutes = 5 } = {}) {
  const agent = store.getAgent(targetUid);
  if (!agent) return { ok: false, error: `agent ${targetUid} not found` };

  // Guard: cannot sleep PM/PMO.
  const role = agent.role || 'worker';
  if (role === 'supervisor' || role === 'pmo') {
    return {
      ok: false,
      error: `cannot sleep agent with role "${role}". Only workers can be put to sleep.`,
      hint: 'PM and PMO agents are protected from sleep to ensure leadership availability.',
    };
  }

  // Clear any existing sleep timer.
  const existing = _sleepState.get(targetUid);
  if (existing && existing.timer) clearTimeout(existing.timer);

  const since = _now();
  const delayMs = _wakeAfterMs(wakeAfterMinutes);
  const wakeAt = new Date(Date.now() + delayMs).toISOString();

  // Inject /compact into PTY.
  let compacted = false;
  let ptyError = null;
  const session = await _findSessionByUid(targetUid);
  if (session) {
    try {
      await _injectCommand(session.id, COMPACT_CMD);
      compacted = true;
    } catch (e) {
      ptyError = e.message;
    }
  }

  // Schedule auto-wake timer.
  const timer = setTimeout(() => {
    _sleepState.delete(targetUid);
    // Auto-wake: inject check_inbox — best-effort, don't throw.
    wake(targetUid).catch(() => {});
  }, delayMs);
  timer.unref(); // don't keep process alive for sleep timers.

  _sleepState.set(targetUid, { since, wakeAt, wakeAfterMinutes, timer });

  return {
    ok: true,
    uid: targetUid,
    name: agent.name,
    sleeping: true,
    sleep_since: since,
    wake_at: wakeAt,
    wake_after_minutes: wakeAfterMinutes,
    compact_injected: compacted,
    pty_error: ptyError || undefined,
    hint: compacted
      ? `Agent ${agent.name} sleeping. Auto-wake in ${wakeAfterMinutes} min at ${wakeAt}.`
      : `Agent ${agent.name} marked sleeping (no active PTY — /compact not injected). Auto-wake in ${wakeAfterMinutes} min.`,
  };
}

// ── wake ─────────────────────────────────────────────────────────────────

/**
 * Wake a sleeping agent. Clears the auto-wake timer and injects check_inbox
 * into their PTY so they immediately poll for new tasks.
 *
 * @param {string} targetUid
 * @returns {{ ok, uid, name, was_sleeping, woken_at }}
 */
async function wake(targetUid) {
  const agent = store.getAgent(targetUid);
  if (!agent) return { ok: false, error: `agent ${targetUid} not found` };

  const sleepEntry = _sleepState.get(targetUid);

  // Clear sleep timer if any.
  if (sleepEntry && sleepEntry.timer) {
    clearTimeout(sleepEntry.timer);
    _sleepState.delete(targetUid);
  }

  // Inject check_inbox via PTY.
  let ptyInjected = false;
  let ptyError = null;
  const session = await _findSessionByUid(targetUid);
  if (session) {
    try {
      await _injectCommand(session.id, WAKE_CMD);
      ptyInjected = true;
    } catch (e) {
      ptyError = e.message;
    }
  }

  const wasSleeping = !!sleepEntry;

  return {
    ok: true,
    uid: targetUid,
    name: agent.name,
    was_sleeping: wasSleeping,
    woken_at: _now(),
    pty_injected: ptyInjected,
    pty_error: ptyError || undefined,
    hint: wasSleeping
      ? `Agent ${agent.name} woken from sleep${ptyInjected ? ' — check_inbox injected.' : '.'}`
      : `Agent ${agent.name} was not sleeping${ptyInjected ? ' — check_inbox injected anyway.' : '.'}`,
  };
}

// ── status query ─────────────────────────────────────────────────────────

/**
 * Get sleep status for one or all agents.
 *
 * @param {string} [targetUid] — if omitted, returns all sleeping agents.
 * @returns {{ sleeping: boolean, agents?: Array }}
 */
function getSleepStatus(targetUid) {
  if (targetUid) {
    const entry = _sleepState.get(targetUid);
    if (!entry) return { uid: targetUid, sleeping: false };
    return {
      uid: targetUid,
      sleeping: true,
      sleep_since: entry.since,
      wake_at: entry.wakeAt,
      wake_after_minutes: entry.wakeAfterMinutes,
    };
  }

  // All sleeping agents.
  const sleeping = [];
  for (const [uid, entry] of _sleepState) {
    const agent = store.getAgent(uid);
    sleeping.push({
      uid,
      name: agent ? agent.name : '(unknown)',
      sleep_since: entry.since,
      wake_at: entry.wakeAt,
      wake_after_minutes: entry.wakeAfterMinutes,
    });
  }
  return { sleeping: sleeping.length > 0, count: sleeping.length, agents: sleeping };
}

/**
 * Cancel all sleep timers (e.g. on server shutdown). No-op if none active.
 */
function cancelAllSleepTimers() {
  for (const [uid, entry] of _sleepState) {
    if (entry.timer) clearTimeout(entry.timer);
    _sleepState.delete(uid);
  }
}

module.exports = { sleep, wake, getSleepStatus, cancelAllSleepTimers };

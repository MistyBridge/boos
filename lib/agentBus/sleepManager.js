// Sleep/Wake Manager — Sprint 31 Phase 6.
//
// Manages agent sleep/wake lifecycle via PTY command injection.
// Integration: handlersDag._dagSleepAgent → sleepManager.sleep()
//              handlersDag._dagWakeAgent → sleepManager.wake()
//
// Design constraints:
//   - Leaf module — requires store + ptyInjectionQueue.
//   - Only workers can be put to sleep (PM/PMO are protected).
//   - Auto-wake timer fires after configurable minutes (default 5).
//   - Sleep state is in-memory only (reset on server restart).
//
// Sprint N: All PTY injection routed through ptyInjectionQueue.enqueue().

'use strict';

const store = require('./store');
const ptyInjectionQueue = require('./ptyInjectionQueue');

// ── commands ─────────────────────────────────────────────────────────────

const COMPACT_CMD = '/compact';
const WAKE_CMD = 'check_inbox[BOOS]';

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

  // Inject /compact via PTY injection queue (flow-controlled).
  let compacted = false;
  let ptyError = null;
  try {
    const enqResult = await ptyInjectionQueue.enqueue(targetUid, COMPACT_CMD);
    compacted = enqResult.queued || false;
  } catch (e) {
    ptyError = e.message;
  }

  // Schedule auto-wake timer.
  const timer = setTimeout(() => {
    _sleepState.delete(targetUid);
    wake(targetUid).catch(() => {});
  }, delayMs);
  timer.unref();

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

  // Inject check_inbox via PTY injection queue (flow-controlled).
  let ptyInjected = false;
  let ptyError = null;
  try {
    const enqResult = await ptyInjectionQueue.enqueue(targetUid, WAKE_CMD);
    ptyInjected = enqResult.queued || false;
  } catch (e) {
    ptyError = e.message;
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

function cancelAllSleepTimers() {
  for (const [uid, entry] of _sleepState) {
    if (entry.timer) clearTimeout(entry.timer);
    _sleepState.delete(uid);
  }
}

module.exports = { sleep, wake, getSleepStatus, cancelAllSleepTimers };

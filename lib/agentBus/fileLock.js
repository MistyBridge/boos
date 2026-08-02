// Agent-Bus File Lock Manager — single-writer file access control.
//
// Sprint 36 redesign: agents request a file lock without caring about
// file state or sandbox boundaries — BOOS handles all of that.
//
// When a file is locked by another agent, the caller is queued (FIFO)
// and receives an immediate "queued" response. When the lock is released,
// BOOS auto-grants to the next waiter and notifies them via SSE + wake.
//
// Wait queue is in-memory only (survives server lifetime, not restarts).
// Stale waiters (disconnected agents) are pruned on sweep.
//
// MCP tools exposed:
//   request_file_lock(file_path)   → grant / queued
//   release_file_lock(file_path)   → released + auto-grant to next waiter
//   list_file_locks()             → all active locks

'use strict';

const path = require('node:path');

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const SWEEP_INTERVAL_MS = 60_000;       // 1 min

let _store = null;    // set by inject()
const _locks = new Map();   // filePath → { agent_uid, agent_name, granted_at, expires_at }
const _waiters = new Map(); // filePath → [{ agent_uid, agent_name, requested_at }]
let _sweepTimer = null;

// Callbacks set by the caller (handlersSession) for notification delivery.
let _onGrantToWaiter = null; // (agentUid, filePath, holderName) => void

// ── init ─────────────────────────────────────────────────────────────────

function inject(storeRef) {
  _store = storeRef;
}

function setOnGrantToWaiter(fn) {
  _onGrantToWaiter = fn;
}

function start() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();
}

function stop() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

// ── core API ─────────────────────────────────────────────────────────────

/**
 * Request a file lock.
 *
 * - If the file is free → grant immediately.
 * - If the file is locked by the SAME agent → refresh (extend timeout).
 * - If the file is locked by ANOTHER agent → queue the caller, return
 *   { ok: false, status: 'queued', position, holder }.
 *   BOOS will auto-notify when the lock is released.
 */
function requestLock(agentUid, agentName, filePath) {
  const fp = normalizePath(filePath);
  if (!fp) return { ok: false, error: 'invalid file path' };

  const existing = _locks.get(fp);

  if (existing) {
    // Same agent re-requesting → refresh the lock.
    if (existing.agent_uid === agentUid) {
      existing.granted_at = Date.now();
      existing.expires_at = Date.now() + LOCK_TIMEOUT_MS;
      return { ok: true, path: fp, status: 'refreshed', holder: agentUid };
    }

    // Another agent holds the lock — check expiry.
    if (Date.now() > existing.expires_at) {
      // Expired → steal (old holder presumably disconnected/crashed).
      _locks.delete(fp);
      // Also clear any stale waiters for this path.
      _waiters.delete(fp);
    } else {
      // Lock is valid and held by someone else → queue the caller.
      const queue = _waiters.get(fp) || [];
      // Avoid duplicate queuing for the same agent + file.
      if (!queue.find((w) => w.agent_uid === agentUid)) {
        queue.push({
          agent_uid: agentUid,
          agent_name: agentName || agentUid,
          requested_at: Date.now(),
        });
        _waiters.set(fp, queue);
      }
      const position = queue.findIndex((w) => w.agent_uid === agentUid) + 1;
      return {
        ok: false,
        status: 'queued',
        path: fp,
        position,
        queue_length: queue.length,
        holder: existing.agent_uid,
        holder_name: existing.agent_name,
        hint: `File is locked by ${existing.agent_name}. You are #${position} in queue. BOOS will auto-notify when the lock is released.`,
      };
    }
  }

  // File is free → grant.
  _locks.set(fp, {
    agent_uid: agentUid,
    agent_name: agentName || agentUid,
    granted_at: Date.now(),
    expires_at: Date.now() + LOCK_TIMEOUT_MS,
  });

  return { ok: true, path: fp, status: 'granted', holder: agentUid };
}

/**
 * Release a file lock.
 *
 * If there are waiters in the queue for this file, the lock is
 * automatically granted to the first waiter in FIFO order.
 * Returns the next holder's uid so the handler can notify them.
 */
function releaseLock(agentUid, filePath) {
  const fp = normalizePath(filePath);
  if (!fp) return { ok: false, error: 'invalid file path' };

  const existing = _locks.get(fp);
  if (!existing) {
    // Not locked — but clean up any orphaned waiters anyway.
    _waiters.delete(fp);
    return { ok: true, path: fp, status: 'not_locked' };
  }

  // Only the lock holder (or supervisor) can release.
  if (existing.agent_uid !== agentUid) {
    if (_store) {
      const agent = _store.getAgent(agentUid);
      if (agent && agent.role === 'supervisor') {
        _locks.delete(fp);
        const next = _dequeueNext(fp);
        return {
          ok: true, path: fp, status: 'force_released',
          previous_holder: existing.agent_uid,
          next_holder: next ? next.agent_uid : null,
        };
      }
    }
    return { ok: false, error: 'lock held by ' + existing.agent_name + ', not ' + agentUid };
  }

  // Normal release.
  _locks.delete(fp);

  // Auto-grant to next waiter.
  const next = _dequeueNext(fp);

  return {
    ok: true,
    path: fp,
    status: 'released',
    next_holder: next ? next.agent_uid : null,
    next_holder_name: next ? next.agent_name : null,
    queue_remaining: (_waiters.get(fp) || []).length,
  };
}

// ── queue management ────────────────────────────────────────────────────

/**
 * Dequeue the first waiter for a file path and auto-grant them the lock.
 * Returns the dequeued waiter or null if the queue is empty.
 */
function _dequeueNext(fp) {
  const queue = _waiters.get(fp);
  if (!queue || queue.length === 0) {
    _waiters.delete(fp);
    return null;
  }

  const next = queue.shift();

  if (queue.length === 0) {
    _waiters.delete(fp);
  }

  // Grant the lock to the next waiter.
  _locks.set(fp, {
    agent_uid: next.agent_uid,
    agent_name: next.agent_name,
    granted_at: Date.now(),
    expires_at: Date.now() + LOCK_TIMEOUT_MS,
  });

  // Fire callback for notification delivery.
  if (_onGrantToWaiter) {
    try {
      _onGrantToWaiter(next.agent_uid, fp, next.agent_name);
    } catch {}
  }

  return next;
}

/**
 * Get the current wait queue for a file (for diagnostics).
 */
function getWaitQueue(filePath) {
  const fp = normalizePath(filePath);
  if (!fp) return [];
  const queue = _waiters.get(fp) || [];
  return queue.map((w, i) => ({
    position: i + 1,
    agent_uid: w.agent_uid,
    agent_name: w.agent_name,
    waiting_since: new Date(w.requested_at).toISOString(),
  }));
}

/**
 * Remove a specific agent from all wait queues (called on disconnect).
 */
function removeFromAllWaitQueues(agentUid) {
  let removed = 0;
  for (const [fp, queue] of _waiters) {
    const idx = queue.findIndex((w) => w.agent_uid === agentUid);
    if (idx >= 0) {
      queue.splice(idx, 1);
      removed++;
      if (queue.length === 0) _waiters.delete(fp);
    }
  }
  return removed;
}

// ── query API ───────────────────────────────────────────────────────────

function listLocks() {
  const result = [];
  for (const [fp, lock] of _locks) {
    const queue = _waiters.get(fp) || [];
    result.push({
      path: fp,
      agent_uid: lock.agent_uid,
      agent_name: lock.agent_name,
      granted_at: new Date(lock.granted_at).toISOString(),
      expires_at: new Date(lock.expires_at).toISOString(),
      waiters: queue.length,
    });
  }
  return { ok: true, locks: result, count: result.length };
}

// Release ALL locks held by an agent (called on disconnect).
function releaseAllForAgent(agentUid) {
  let released = 0;
  for (const [fp, lock] of _locks) {
    if (lock.agent_uid === agentUid) {
      // Release and auto-grant to next waiter.
      _locks.delete(fp);
      _dequeueNext(fp);
      released++;
    }
  }
  // Also remove from all wait queues.
  removeFromAllWaitQueues(agentUid);
  return { ok: true, released };
}

// ── maintenance ──────────────────────────────────────────────────────────

function sweepExpired() {
  const now = Date.now();
  let swept = 0;
  let waitersPruned = 0;

  for (const [fp, lock] of _locks) {
    if (now > lock.expires_at) {
      _locks.delete(fp);
      // Auto-grant to next waiter if any.
      _dequeueNext(fp);
      swept++;
    }
  }

  // Prune waiters from agents no longer registered.
  if (_store) {
    for (const [fp, queue] of _waiters) {
      const before = queue.length;
      const filtered = queue.filter((w) => _store.getAgent(w.agent_uid));
      if (filtered.length < before) {
        waitersPruned += (before - filtered.length);
        if (filtered.length === 0) {
          _waiters.delete(fp);
        } else {
          _waiters.set(fp, filtered);
        }
      }
    }
  }

  const total = swept + waitersPruned;
  if (total > 0) console.log('[fileLock] swept', swept, 'expired locks +', waitersPruned, 'stale waiters');
  return { swept, waiters_pruned: waitersPruned, total };
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  try {
    return path.normalize(p).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

module.exports = {
  inject, start, stop,
  requestLock, releaseLock, listLocks,
  releaseAllForAgent, sweepExpired,
  getWaitQueue, removeFromAllWaitQueues,
  setOnGrantToWaiter,
};

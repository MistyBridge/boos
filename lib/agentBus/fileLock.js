// Agent-Bus File Lock Manager — single-writer file access control.
//
// Sprint 10 R13: agents must request permission before modifying any file.
// Only one agent can hold the write lock on a specific file at a time.
// Locks auto-release on timeout (5 min) or agent disconnect.
//
// MCP tools exposed:
//   request_file_lock(agent_uid, file_path) → grant/deny
//   release_file_lock(agent_uid, file_path) → released
//   list_file_locks() → all active locks

'use strict';

const path = require('node:path');

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const SWEEP_INTERVAL_MS = 60_000; // 1 min

let _store = null;    // set by inject()
const _locks = new Map(); // filePath (normalized) → { agent_uid, agent_name, granted_at, expires_at }
let _sweepTimer = null;

// ── init ─────────────────────────────────────────────────────────────────

function inject(storeRef) {
  _store = storeRef;
}

function start() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();
}

function stop() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

// ── core API ─────────────────────────────────────────────────────────────

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
    // Another agent holds the lock → check expiry.
    if (Date.now() > existing.expires_at) {
      // Expired → steal.
      _locks.delete(fp);
    } else {
      return {
        ok: false, error: 'file locked by ' + existing.agent_name,
        path: fp, holder: existing.agent_uid, holder_name: existing.agent_name,
        expires_at: new Date(existing.expires_at).toISOString(),
      };
    }
  }

  _locks.set(fp, {
    agent_uid: agentUid,
    agent_name: agentName || agentUid,
    granted_at: Date.now(),
    expires_at: Date.now() + LOCK_TIMEOUT_MS,
  });

  return { ok: true, path: fp, status: 'granted', holder: agentUid };
}

function releaseLock(agentUid, filePath) {
  const fp = normalizePath(filePath);
  if (!fp) return { ok: false, error: 'invalid file path' };

  const existing = _locks.get(fp);
  if (!existing) return { ok: true, path: fp, status: 'not_locked' };

  // Only the lock holder (or supervisor) can release.
  if (existing.agent_uid !== agentUid) {
    // Check if caller is supervisor.
    if (_store) {
      const agent = _store.getAgent(agentUid);
      if (agent && agent.role === 'supervisor') {
        _locks.delete(fp);
        return { ok: true, path: fp, status: 'force_released', previous_holder: existing.agent_uid };
      }
    }
    return { ok: false, error: 'lock held by ' + existing.agent_name + ', not ' + agentUid };
  }

  _locks.delete(fp);
  return { ok: true, path: fp, status: 'released' };
}

function listLocks() {
  const result = [];
  for (const [fp, lock] of _locks) {
    result.push({
      path: fp,
      agent_uid: lock.agent_uid,
      agent_name: lock.agent_name,
      granted_at: new Date(lock.granted_at).toISOString(),
      expires_at: new Date(lock.expires_at).toISOString(),
    });
  }
  return { ok: true, locks: result, count: result.length };
}

// Release ALL locks held by an agent (called on disconnect).
function releaseAllForAgent(agentUid) {
  let released = 0;
  for (const [fp, lock] of _locks) {
    if (lock.agent_uid === agentUid) {
      _locks.delete(fp);
      released++;
    }
  }
  return { ok: true, released };
}

// ── maintenance ──────────────────────────────────────────────────────────

function sweepExpired() {
  const now = Date.now();
  let swept = 0;
  for (const [fp, lock] of _locks) {
    if (now > lock.expires_at) {
      _locks.delete(fp);
      swept++;
    }
  }
  if (swept > 0) console.log('[fileLock] swept', swept, 'expired locks');
  return { swept };
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  // Resolve relative paths but keep within repo.
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
};

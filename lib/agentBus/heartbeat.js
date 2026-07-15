// Agent-Bus Heartbeat + Crash Recovery — Sprint 10 R10 + R12.
//
// Sprint 13.3: Event-driven model — no global polling. Each agent gets
// a one-shot timeout scheduled on every touch(). When the timeout fires
// (180s after last activity), the agent is marked unresponsive and its
// in_progress tasks are reassigned. Recovery is instant on next touch().
//
// This is separate from the PTY watchdog (which was removed in Sprint 13).
// An agent can have a live PTY but be stuck/unresponsive at the model
// level. This scanner catches both cases — purely event-driven via
// per-agent setTimeout, zero polling overhead.

'use strict';

const UNRESPONSIVE_THRESHOLD_MS = 180_000; // 3 min without any MCP call
const MAX_AUTO_REASSIGN = 10; // max tasks to auto-reassign per agent

let _store = null;
let _onUnresponsive = null; // callback(uid, agentName, taskCount)
const _timers = new Map();  // uid → setTimeout handle

// ── lifecycle ────────────────────────────────────────────────────────────

function start(storeRef, opts = {}) {
  if (_store) return;  // already started
  _store = storeRef;
  if (opts.onUnresponsive) _onUnresponsive = opts.onUnresponsive;

  // Schedule timeouts for all existing agents.
  try {
    const agents = _store.listAllAgents();
    for (const a of agents) _schedule(a.uid);
  } catch {}

  console.log('[heartbeat] event-driven scanner active (threshold=' + Math.round(UNRESPONSIVE_THRESHOLD_MS / 1000) + 's, per-agent timeouts, zero polling)');
}

function stop() {
  for (const t of _timers.values()) clearTimeout(t);
  _timers.clear();
  _store = null;
}

// ── touch — called on every MCP call (transport.js tools/call + /api/call) ─

async function touch(agentUid) {
  if (!_store) return;
  try {
    await _store.touchAgentHeartbeat(agentUid);
    await _schedule(agentUid);  // reset the per-agent timer
  } catch {}
}

// ── schedule a new agent (called from handlers.js after register_agent) ──

async function scheduleNew(agentUid) {
  if (!_store) return;
  await _schedule(agentUid);
}

// ── query ─────────────────────────────────────────────────────────────────

function isResponsive(agentUid) {
  if (!_store) return true;
  const agent = _store.getAgent(agentUid);
  if (!agent) return true;
  const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
  return (Date.now() - lastSeen) < UNRESPONSIVE_THRESHOLD_MS;
}

function getLiveness(agentUid) {
  if (!_store) return { responsive: true, last_seen_sec: 0 };
  const agent = _store.getAgent(agentUid);
  if (!agent) return { responsive: true, last_seen_sec: 0 };
  const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
  const sec = Math.round((Date.now() - lastSeen) / 1000);
  return { responsive: sec < UNRESPONSIVE_THRESHOLD_MS / 1000, last_seen_sec: sec, unresponsive: agent.unresponsive || false };
}

// ── per-agent timeout scheduling ──────────────────────────────────────────

async function _schedule(uid) {
  // Clear any existing timer for this agent.
  if (_timers.has(uid)) {
    clearTimeout(_timers.get(uid));
    _timers.delete(uid);
  }

  if (!_store) return;
  const agent = _store.getAgent(uid);
  if (!agent) return;

  // Sprint 13: root agent is permanent — never mark unresponsive.
  if (agent.role === 'root') return;

  // If agent was marked unresponsive but now has activity → instant recovery.
  if (agent.unresponsive) {
    await _store.setAgentUnresponsive(uid, false);
    console.log('[heartbeat] agent', agent.name, '(' + uid.slice(-8) + ') recovered');
  }

  // Schedule one-shot timeout: if no activity for threshold, mark unresponsive.
  const timer = setTimeout(() => _onTimeout(uid), UNRESPONSIVE_THRESHOLD_MS);
  timer.unref();
  _timers.set(uid, timer);
}

async function _onTimeout(uid) {
  _timers.delete(uid);
  if (!_store) return;

  const agent = _store.getAgent(uid);
  if (!agent) return;

  // Double-check: touch() may have been called between the timer firing
  // and this callback executing (Node.js event loop ordering).
  const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
  const elapsed = Date.now() - lastSeen;
  if (elapsed < UNRESPONSIVE_THRESHOLD_MS) {
    // Still active — re-schedule.
    await _schedule(uid);
    return;
  }

  // Mark unresponsive + reassign in_progress tasks.
  await _store.setAgentUnresponsive(uid, true);
  console.log('[heartbeat] agent', agent.name, '(' + uid.slice(-8) + ') unresponsive after', Math.round(elapsed / 1000), 's');

  const count = await _reassignTasks(uid, agent.name);

  if (_onUnresponsive) {
    try { _onUnresponsive(uid, agent.name, count); } catch {}
  }
}

// ── task reassign ─────────────────────────────────────────────────────────

async function _reassignTasks(uid, agentName) {
  if (!_store) return 0;
  try {
    // Sprint 13.3: use withFileLock to prevent race with concurrent
    // task inserts/updates (was raw readFileSync + atomicWriteJson).
    const { withFileLock } = require('../atomicJson');
    let count = 0;
    await withFileLock(_store.DB_PATH, async () => {
      const fs = require('fs');
      const db = JSON.parse(fs.readFileSync(_store.DB_PATH, 'utf-8'));
      for (const [tid, t] of Object.entries(db.tasks || {})) {
        if (t.receiver_uid !== uid) continue;
        if (t.status !== 'in_progress') continue;
        if (count >= MAX_AUTO_REASSIGN) break;

        // Reset to pending so other agents (or the generalist) can pick it up.
        // Don't increment retry_count — this was a crash, not a failure.
        t.status = 'pending';
        t.reassigned_from = uid;
        t.reassigned_at = new Date().toISOString();
        t.reassign_reason = 'agent ' + agentName + ' unresponsive';
        count++;
      }
      if (count > 0) {
        const { atomicWriteJson } = require('../atomicJson');
        atomicWriteJson(_store.DB_PATH, db);
      }
    });
    return count;
  } catch (e) {
    console.warn('[heartbeat] reassign error:', e.message);
    return 0;
  }
}

module.exports = { start, stop, touch, scheduleNew, isResponsive, getLiveness, UNRESPONSIVE_THRESHOLD_MS };

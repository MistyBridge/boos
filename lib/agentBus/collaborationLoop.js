// Agent collaboration loop — idle/busy state tracking + idle-preference routing.
//
// Sprint 8 Wave 2.5: solves the "low collaboration willingness" problem by
// giving the system visibility into which agents are available for new work.
//
// State model:
//   idle  — no tasks in_progress, ready for new assignments
//   busy  — has >= 1 task in_progress
//
// When capability-routing a task, idle agents are preferred over busy ones.
// When all matching agents are busy, the task still routes to the best match
// (queued behind current work).

'use strict';

const store = require('./store');

// Per-agent busyness tracking (derived from task status).
// Keyed by agent UID, value is { state: 'idle'|'busy', taskCount: number }.
const _agentState = new Map();

// ── Generalist agent (Sprint 8 #72) ──────────────────────────────────────
// Ensures a catch-all agent exists for tasks that don't match any specialist.

const GENERALIST_NAME = '通用助手';
const GENERALIST_CAPS = ['general', 'misc', 'documentation', 'research'];
const GENERALIST_INTRO = 'BOOS 通用助手 — 处理不属于前端/后端/测试领域的杂项任务。当专业 agent 无法匹配时由系统自动路由。';

let _generalistUid = null;
let _initialized = false;

async function ensureGeneralistAgent(registry, workspace) {
  if (_initialized) return _generalistUid;
  _initialized = true;

  try {
    const result = await registry.registerAgent({
      name: GENERALIST_NAME,
      intro: GENERALIST_INTRO,
      workspace,
      role: 'worker',
      capabilities: GENERALIST_CAPS,
    });
    _generalistUid = result.uid;
    return _generalistUid;
  } catch (e) {
    console.error('[boos] collaborationLoop: failed to register generalist agent:', e.message);
    return null;
  }
}

function getGeneralistUid() {
  return _generalistUid;
}

function _deriveState(uid) {
  const tasks = store.listMyTasks(uid);
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  return inProgress > 0 ? 'busy' : 'idle';
}

function getAgentState(uid) {
  if (!_agentState.has(uid)) {
    _agentState.set(uid, { state: 'idle', taskCount: 0 });
  }
  // Refresh from store to stay accurate.
  const state = _deriveState(uid);
  const tasks = store.listMyTasks(uid);
  _agentState.set(uid, { state, taskCount: tasks.length });
  return _agentState.get(uid);
}

function refreshState(uid) {
  const state = _deriveState(uid);
  const tasks = store.listMyTasks(uid);
  _agentState.set(uid, { state, taskCount: tasks.length });
  return _agentState.get(uid);
}

// Sort agents by preference: idle first, then by capability match score.
// Used to pick the best available agent for a task.
function rankByAvailability(agents, requiredCaps) {
  const scored = agents.map((a) => {
    const agentState = getAgentState(a.uid);
    const agentCaps = new Set(a.capabilities || []);
    const capScore = requiredCaps.filter((c) => agentCaps.has(c)).length;
    return {
      agent: a,
      capScore,
      isIdle: agentState.state === 'idle',
    };
  });

  // Sort: idle + high cap score first, busy + low cap score last.
  scored.sort((a, b) => {
    if (a.isIdle !== b.isIdle) return a.isIdle ? -1 : 1; // idle first
    return b.capScore - a.capScore; // then by capability match
  });

  return scored;
}

// Find the best available agent for a task with required capabilities.
// Returns agent UID or null.
function findBestAgent(agents, requiredCaps, senderUid) {
  const candidates = agents.filter((a) => a.uid !== senderUid);
  if (candidates.length === 0) return null;

  const ranked = rankByAvailability(candidates, requiredCaps);
  const best = ranked[0];

  // If no capability match at all, check for generalist.
  if (best.capScore === 0) {
    const generalist = candidates.find((a) => (a.capabilities || []).includes('general'));
    if (generalist) return generalist.uid;
  }

  return best.agent.uid;
}

// Notification message for collaboration status.
function collaborationStatus(uid) {
  const state = getAgentState(uid);
  return {
    agent_uid: uid,
    state: state.state,
    ready_for_work: state.state === 'idle',
  };
}

// ── Round-robin load balancing (Sprint 8 #69) ────────────────────────────
// When multiple agents have identical idle state + capability match scores,
// distribute tasks evenly using a per-capability round-robin counter.

const _rrCounters = new Map(); // key: capKey → next agent index

function _nextRoundRobin(agents, requiredCaps) {
  const key = (requiredCaps || []).sort().join(',') || '__empty__';
  let idx = _rrCounters.get(key) || 0;
  _rrCounters.set(key, (idx + 1) % agents.length);
  return agents[idx % agents.length];
}

// ── findBestAgent with round-robin tiebreaking ───────────────────────────

function findBestAgent(agents, requiredCaps, senderUid) {
  const candidates = agents.filter((a) => a.uid !== senderUid);
  if (candidates.length === 0) return null;

  const ranked = rankByAvailability(candidates, requiredCaps);
  const best = ranked[0];

  // If no capability match at all, check for generalist.
  if (best.capScore === 0) {
    const generalist = candidates.find((a) => (a.capabilities || []).includes('general'));
    if (generalist) return generalist.uid;
  }

  // Round-robin: if multiple agents share the top (idle + capScore), pick
  // the one whose turn it is. This distributes work evenly instead of always
  // routing to the same agent.
  const topTier = ranked.filter(r => r.isIdle === best.isIdle && r.capScore === best.capScore);
  if (topTier.length > 1) {
    return _nextRoundRobin(topTier.map(r => r.agent), requiredCaps).uid;
  }

  return best.agent.uid;
}

module.exports = {
  getAgentState,
  refreshState,
  rankByAvailability,
  findBestAgent,
  collaborationStatus,
  ensureGeneralistAgent,
  getGeneralistUid,
  GENERALIST_NAME,
};

// Agent collaboration loop — idle/busy state tracking + idle-preference routing.
//
// Sprint 35: store.listMyTasks is now async (per-agent inbox files).
// All state derivation is async; callers propagate await.

'use strict';

const store = require('./store');

const _agentState = new Map();

// ── Generalist agent ────────────────────────────────────────────────────

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

function getGeneralistUid() { return _generalistUid; }

// ── state derivation ────────────────────────────────────────────────────

async function _deriveState(uid) {
  try {
    const tasks = await store.listMyTasks(uid);
    const inProgress = (tasks || []).filter((t) => t.status === 'in_progress').length;
    return inProgress > 0 ? 'busy' : 'idle';
  } catch { return 'idle'; }
}

function _countActive(tasks) {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) =>
    t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked'
  ).length;
}

async function getAgentState(uid) {
  try {
    const state = await _deriveState(uid);
    const tasks = await store.listMyTasks(uid);
    const entry = { state, taskCount: _countActive(tasks) };
    _agentState.set(uid, entry);
    return entry;
  } catch {
    return _agentState.get(uid) || { state: 'idle', taskCount: 0 };
  }
}

async function refreshState(uid) {
  return getAgentState(uid);
}

// ── routing ─────────────────────────────────────────────────────────────

async function rankByAvailability(agents, requiredCaps) {
  const results = [];
  for (const a of agents) {
    const agentState = await getAgentState(a.uid);
    const agentCaps = new Set(a.capabilities || []);
    const capScore = requiredCaps.filter((c) => agentCaps.has(c)).length;
    results.push({ agent: a, capScore, isIdle: agentState.state === 'idle' });
  }
  results.sort((a, b) => {
    if (a.isIdle !== b.isIdle) return a.isIdle ? -1 : 1;
    return b.capScore - a.capScore;
  });
  return results;
}

const _rrCounters = new Map();

function _nextRoundRobin(agents, requiredCaps) {
  const key = (requiredCaps || []).sort().join(',') || '__empty__';
  let idx = _rrCounters.get(key) || 0;
  _rrCounters.set(key, (idx + 1) % agents.length);
  return agents[idx % agents.length];
}

async function findBestAgent(agents, requiredCaps, senderUid) {
  const candidates = agents.filter((a) => a.uid !== senderUid);
  if (candidates.length === 0) return null;

  const ranked = await rankByAvailability(candidates, requiredCaps);
  const best = ranked[0];

  if (best.capScore === 0) {
    const generalist = candidates.find((a) => (a.capabilities || []).includes('general'));
    if (generalist) return generalist.uid;
  }

  const topTier = ranked.filter(r => r.isIdle === best.isIdle && r.capScore === best.capScore);
  if (topTier.length > 1) {
    return _nextRoundRobin(topTier.map(r => r.agent), requiredCaps).uid;
  }

  return best.agent.uid;
}

async function collaborationStatus(uid) {
  const state = await getAgentState(uid);
  return { agent_uid: uid, state: state.state, ready_for_work: state.state === 'idle' };
}

module.exports = {
  getAgentState, refreshState, rankByAvailability,
  findBestAgent, collaborationStatus,
  ensureGeneralistAgent, getGeneralistUid,
  GENERALIST_NAME,
};

// DAG Workflow Engine — Supervisor Agent orchestrates multi-stage workflows.
//
// Persisted to ~/.boos/workflows.json via atomicJson.
// Activated workflows auto-dispatch stages to matched worker agents when
// dependencies resolve. Completion cascades trigger downstream dispatch.
//
// MCP Tools (in schemas.js + handlers.js):
//   define_workflow, add_stage, add_dependency, activate_workflow

'use strict';

const path = require('node:path');
const { atomicWriteJson, withFileLock } = require('./atomicJson');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'workflows.json');
const EMPTY_DB = { workflows: {} };

// ── internal persistence ───────────────────────────────────────────────

async function _load() {
  try {
    const raw = await require('node:fs/promises').readFile(FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw e;
  }
}

async function _save(db) {
  await atomicWriteJson(FILE, db);
}

/**
 * ⚠️ DEPRECATED — reads WITHOUT withFileLock. Use async _load() instead.
 * @deprecated since Sprint 17 — retained for read-only backward compat.
 */
function _syncLoad() {
  try {
    return JSON.parse(require('fs').readFileSync(FILE, 'utf-8'));
  } catch {
    return structuredClone(EMPTY_DB);
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function _genId(prefix) {
  return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Cycle detection via DFS. Returns true if adding edge from→to would create a cycle.
function _wouldCycle(edges, from, to) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  // Add the proposed edge.
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push(to);

  // DFS from `to` — if we can reach `from`, it's a cycle.
  const visited = new Set();
  const stack = [to];
  while (stack.length) {
    const node = stack.pop();
    if (node === from) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adj.get(node) || []) stack.push(next);
  }
  return false;
}

// ── workflow CRUD ──────────────────────────────────────────────────────

async function defineWorkflow(name, description, ownerUid, workspace) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const wfId = _genId('wf_');
    const now = new Date().toISOString();
    const wf = {
      workflow_id: wfId,
      name: String(name || '').slice(0, 128),
      description: String(description || '').slice(0, 512),
      workspace,
      owner_uid: ownerUid,
      status: 'draft',
      stages: {},
      edges: [],
      created_at: now,
      updated_at: now,
    };
    db.workflows[wfId] = wf;
    await _save(db);
    return { ok: true, workflow_id: wfId, name: wf.name, status: 'draft' };
  });
}

async function addStage(workflowId, { name, description, content, required_capabilities }, ownerUid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const wf = db.workflows[workflowId];
    if (!wf) return { ok: false, error: 'workflow not found' };
    if (wf.owner_uid !== ownerUid) return { ok: false, error: 'only the workflow owner can add stages' };
    if (wf.status !== 'draft') return { ok: false, error: 'workflow must be in draft status' };

    const stageId = _genId('stage_');
    const stage = {
      stage_id: stageId,
      name: String(name || '').slice(0, 128),
      description: String(description || '').slice(0, 256),
      content: String(content || ''),
      required_capabilities: Array.isArray(required_capabilities) ? required_capabilities.slice(0, 10) : [],
      assigned_agent_uid: null,
      task_id: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    wf.stages[stageId] = stage;
    wf.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true, stage_id: stageId };
  });
}

async function addDependency(workflowId, fromStageId, toStageId, ownerUid) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const wf = db.workflows[workflowId];
    if (!wf) return { ok: false, error: 'workflow not found' };
    if (wf.owner_uid !== ownerUid) return { ok: false, error: 'only the workflow owner can add dependencies' };
    if (wf.status !== 'draft') return { ok: false, error: 'workflow must be in draft status' };
    if (!wf.stages[fromStageId] || !wf.stages[toStageId]) {
      return { ok: false, error: 'stage not found' };
    }
    if (_wouldCycle(wf.edges, fromStageId, toStageId)) {
      return { ok: false, error: 'dependency would create a cycle' };
    }
    // Avoid duplicate edges.
    const exists = wf.edges.some((e) => e.from === fromStageId && e.to === toStageId);
    if (exists) return { ok: true, workflow_id: workflowId, edge: { from: fromStageId, to: toStageId }, duplicate: true };

    wf.edges.push({ from: fromStageId, to: toStageId });
    wf.updated_at = new Date().toISOString();
    await _save(db);
    return { ok: true, workflow_id: workflowId, edge: { from: fromStageId, to: toStageId } };
  });
}

// ── activation + dispatch ──────────────────────────────────────────────

// Find stages whose upstream dependencies are all 'completed'.
function _readyStages(wf) {
  const upstreamCompleted = new Set();
  for (const [sid, stage] of Object.entries(wf.stages)) {
    if (stage.status === 'completed') upstreamCompleted.add(sid);
    if (stage.status === 'pending') {
      const deps = wf.edges.filter((e) => e.to === sid).map((e) => e.from);
      if (deps.every((d) => upstreamCompleted.has(d))) {
        // All upstream are completed (or there are no deps).
      } else if (deps.length === 0) {
        // No dependencies — always ready.
      } else {
        continue; // blocked
      }
    } else {
      continue; // not pending
    }
  }
  // Re-compute: pending stages where all deps are completed.
  const ready = [];
  for (const [sid, stage] of Object.entries(wf.stages)) {
    if (stage.status !== 'pending') continue;
    const deps = wf.edges.filter((e) => e.to === sid).map((e) => e.from);
    if (deps.length === 0 || deps.every((d) => wf.stages[d] && wf.stages[d].status === 'completed')) {
      ready.push(sid);
    }
  }
  return ready;
}

// Dispatch ready stages to matched agents.
// `dispatchFn` is (agentUid, content, metadata) → { task_id } — injected by handlers.js.
async function activateWorkflow(workflowId, ownerUid, dispatchFn) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const wf = db.workflows[workflowId];
    if (!wf) return { ok: false, error: 'workflow not found' };
    if (wf.owner_uid !== ownerUid) return { ok: false, error: 'only the workflow owner can activate' };
    if (wf.status !== 'draft') return { ok: false, error: 'workflow must be in draft status' };

    wf.status = 'active';
    wf.updated_at = new Date().toISOString();

    const dispatched = [];
    const readyIds = _readyStages(wf);
    for (const sid of readyIds) {
      const stage = wf.stages[sid];
      stage.status = 'dispatched';
      stage.updated_at = new Date().toISOString();
      dispatched.push(sid);
    }
    await _save(db);

    // Actually dispatch tasks (outside the lock, best-effort).
    const results = [];
    for (const sid of dispatched) {
      const stage = wf.stages[sid];
      try {
        const r = await dispatchFn(stage.content, stage.required_capabilities, wf.workspace, workflowId, sid);
        if (r && r.task_id) {
          // Update stage with task info (separate lock).
          await _updateStageTask(workflowId, sid, r.assigned_agent_uid, r.task_id);
          results.push({ stage_id: sid, dispatched: true, task_id: r.task_id, agent_uid: r.assigned_agent_uid });
        } else {
          results.push({ stage_id: sid, dispatched: false, reason: 'no matching agent' });
        }
      } catch (e) {
        results.push({ stage_id: sid, dispatched: false, reason: e.message });
      }
    }
    return { ok: true, workflow_id: workflowId, status: 'active', stages_dispatched: results };
  });
}

async function _updateStageTask(workflowId, stageId, agentUid, taskId) {
  return withFileLock(FILE, async () => {
    const db = await _load();
    const wf = db.workflows[workflowId];
    if (!wf || !wf.stages[stageId]) return;
    wf.stages[stageId].assigned_agent_uid = agentUid;
    wf.stages[stageId].task_id = taskId;
    wf.stages[stageId].status = 'dispatched';
    wf.stages[stageId].updated_at = new Date().toISOString();
    wf.updated_at = new Date().toISOString();
    await _save(db);
  });
}

// Called when a workflow stage task completes. Cascades to newly-ready stages.
async function onStageCompleted(taskId, dispatchFn) {
  // Use stored dispatchFn if not provided as argument.
  if (!dispatchFn) dispatchFn = _dispatchFn;
  return withFileLock(FILE, async () => {
    const db = await _load();
    // Find the workflow and stage by task_id.
    let targetWf = null;
    let targetStageId = null;
    for (const [wfId, wf] of Object.entries(db.workflows)) {
      for (const [sid, stage] of Object.entries(wf.stages)) {
        if (stage.task_id === taskId && stage.status === 'dispatched') {
          targetWf = wf;
          targetStageId = sid;
          break;
        }
      }
      if (targetWf) break;
    }
    if (!targetWf) return { ok: false, reason: 'no workflow stage found for task' };

    targetWf.stages[targetStageId].status = 'completed';
    targetWf.stages[targetStageId].updated_at = new Date().toISOString();

    // Find newly-ready stages.
    const newlyReady = _readyStages(targetWf);
    for (const sid of newlyReady) {
      targetWf.stages[sid].status = 'dispatched';
      targetWf.stages[sid].updated_at = new Date().toISOString();
    }

    // Check workflow completion.
    const allStages = Object.values(targetWf.stages);
    if (allStages.every((s) => s.status === 'completed' || s.status === 'failed')) {
      targetWf.status = allStages.every((s) => s.status === 'completed') ? 'completed' : 'failed';
    }

    targetWf.updated_at = new Date().toISOString();
    await _save(db);

    // Dispatch newly-ready stages (outside lock).
    const results = [];
    for (const sid of newlyReady) {
      const stage = targetWf.stages[sid];
      try {
        const r = await dispatchFn(stage.content, stage.required_capabilities, targetWf.workspace, targetWf.workflow_id, sid);
        if (r && r.task_id) {
          await _updateStageTask(targetWf.workflow_id, sid, r.assigned_agent_uid, r.task_id);
          results.push({ stage_id: sid, dispatched: true });
        } else {
          results.push({ stage_id: sid, dispatched: false, reason: 'no matching agent' });
        }
      } catch (e) {
        results.push({ stage_id: sid, dispatched: false, reason: e.message });
      }
    }
    return { ok: true, workflow_id: targetWf.workflow_id, completed_stage: targetStageId, cascaded: results.length, results };
  });
}

// ── queries ────────────────────────────────────────────────────────────

function listWorkflows(workspace) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  return Object.values(db.workflows)
    .filter((w) => w.workspace === workspace)
    .map((w) => ({
      workflow_id: w.workflow_id,
      name: w.name,
      description: w.description,
      status: w.status,
      owner_uid: w.owner_uid,
      stage_count: Object.keys(w.stages).length,
      created_at: w.created_at,
      updated_at: w.updated_at,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function getWorkflow(workflowId) {
  const db = _syncLoad(); // @stale-ok: read-only, no lock needed
  const wf = db.workflows[workflowId];
  if (!wf) return null;
  return {
    ...wf,
    stages: Object.fromEntries(
      Object.entries(wf.stages).map(([id, s]) => [id, { ...s }]),
    ),
  };
}

// Module-level dispatchFn storage — set by handlers.js on first activation.
let _dispatchFn = null;
function setDispatchFn(fn) { _dispatchFn = fn; }
function getDispatchFn() { return _dispatchFn; }

module.exports = {
  defineWorkflow,
  addStage,
  addDependency,
  activateWorkflow,
  onStageCompleted,
  listWorkflows,
  getWorkflow,
  setDispatchFn,
  getDispatchFn,
};

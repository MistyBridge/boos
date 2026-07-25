// Goal persistence store — CRUD for AutoPilot goals in ~/.boos/goals.json.
//
// Goals define acceptance criteria, milestones, and dependency-ordered tasks.
// AutoPilot (lib/autoPilot.js) consumes these to drive autonomous execution.
//
// File: ~/.boos/goals.json — array of goal objects, atomic writes.
// Lines: ≤300

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { atomicWriteJson, withFileLock } = require('./atomicJson');
const { DATA_DIR } = require('./config');

const GOALS_PATH = path.join(DATA_DIR, 'goals.json');

// ── helpers ────────────────────────────────────────────────────────────────

function _genId() {
  return 'goal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function _ts() { return new Date().toISOString(); }

async function _loadAll() {
  try {
    const raw = await fs.promises.readFile(GOALS_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function _saveAll(goals) {
  await atomicWriteJson(GOALS_PATH, goals);
}

// Validate task dependency DAG — every depends_on id must reference a real task.
function _validateDAG(tasks) {
  const ids = new Set(tasks.map((t) => t.task_id));
  const errors = [];
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      if (!ids.has(dep)) {
        errors.push(`task "${t.task_id}" depends on unknown task "${dep}"`);
      }
    }
  }
  return errors;
}

// Validate acceptance criteria references in tasks.
function _validateACRefs(tasks, acs) {
  const acIds = new Set((acs || []).map((a) => a.id));
  const errors = [];
  for (const t of tasks) {
    for (const ref of (t.acceptance_criteria || [])) {
      if (!acIds.has(ref)) {
        errors.push(`task "${t.task_id}" references unknown AC "${ref}"`);
      }
    }
  }
  return errors;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

async function createGoal({ workspace, title, description, acceptance_criteria, milestones, tasks }) {
  if (!workspace || !title) throw Object.assign(new Error('workspace and title required'), { statusCode: 400 });
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw Object.assign(new Error('at least one task required'), { statusCode: 400 });
  }

  // Assign IDs to tasks that lack them.
  const now = _ts();
  const acs = (acceptance_criteria || []).map((a, i) => ({
    id: a.id || `ac${i + 1}`, text: a.text, verified: false,
  }));
  const taskList = tasks.map((t, i) => ({
    task_id: t.task_id || `t${i + 1}`,
    title: String(t.title || '').slice(0, 200),
    description: String(t.description || '').slice(0, 1024),
    assignee: String(t.assignee || ''),
    capabilities: t.capabilities || [],
    status: 'pending',
    depends_on: t.depends_on || [],
    acceptance_criteria: t.acceptance_criteria || [],
    agent_task_id: null,
    result: null,
    retry_count: 0,
    created_at: now,
  }));
  const msList = (milestones || []).map((m, i) => ({
    id: m.id || `m${i + 1}`,
    title: String(m.title || '').slice(0, 200),
    task_ids: m.task_ids || [],
    reached: false,
    compacted_at: null,
  }));

  // Validate DAG + AC refs.
  const dagErrs = _validateDAG(taskList);
  if (dagErrs.length) throw Object.assign(new Error(dagErrs.join('; ')), { statusCode: 400 });
  const acErrs = _validateACRefs(taskList, acs);
  if (acErrs.length) throw Object.assign(new Error(acErrs.join('; ')), { statusCode: 400 });

  const goal = {
    goal_id: _genId(),
    workspace: String(workspace).slice(0, 64),
    title: String(title).slice(0, 200),
    description: String(description || '').slice(0, 2048),
    acceptance_criteria: acs,
    milestones: msList,
    tasks: taskList,
    status: 'draft',
    created_at: now,
    completed_at: null,
  };

  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    all.push(goal);
    await _saveAll(all);
  });

  return goal;
}

async function getGoal(goalId) {
  const all = await _loadAll();
  return all.find((g) => g.goal_id === goalId) || null;
}

async function listGoals({ workspace, status } = {}) {
  let all = await _loadAll();
  if (workspace) all = all.filter((g) => g.workspace === workspace);
  if (status) all = all.filter((g) => g.status === status);
  all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return all;
}

async function updateGoal(goalId, updates) {
  const allowed = ['title', 'description', 'acceptance_criteria', 'milestones', 'tasks', 'status'];
  const patch = {};
  for (const k of allowed) {
    if (k in (updates || {})) patch[k] = updates[k];
  }
  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error('no valid update fields'), { statusCode: 400 });
  }

  let updated = null;
  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    const idx = all.findIndex((g) => g.goal_id === goalId);
    if (idx === -1) return;
    Object.assign(all[idx], patch);
    await _saveAll(all);
    updated = all[idx];
  });
  return updated;
}

async function activateGoal(goalId) {
  let goal = null;
  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    const g = all.find((x) => x.goal_id === goalId);
    if (!g) return;
    if (g.status === 'active') { goal = g; return; }
    if (g.status === 'completed') {
      throw Object.assign(new Error('cannot activate a completed goal'), { statusCode: 409 });
    }
    g.status = 'active';
    g.tasks.forEach((t) => { t.status = 'pending'; t.agent_task_id = null; t.result = null; });
    await _saveAll(all);
    goal = g;
  });
  return goal;
}

async function deleteGoal(goalId) {
  let removed = false;
  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    const idx = all.findIndex((g) => g.goal_id === goalId);
    if (idx === -1) return;
    all.splice(idx, 1);
    await _saveAll(all);
    removed = true;
  });
  return removed;
}

// ── Task-level mutations (used by AutoPilot) ───────────────────────────────

async function updateTask(goalId, taskId, patch) {
  const allowed = ['status', 'agent_task_id', 'result', 'retry_count'];
  const clean = {};
  for (const k of allowed) {
    if (k in (patch || {})) clean[k] = patch[k];
  }
  let updated = null;
  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    const g = all.find((x) => x.goal_id === goalId);
    if (!g) return;
    const t = g.tasks.find((x) => x.task_id === taskId);
    if (!t) return;
    Object.assign(t, clean);
    await _saveAll(all);
    updated = t;
  });
  return updated;
}

async function markMilestone(goalId, milestoneId, reached = true) {
  let updated = null;
  await withFileLock(GOALS_PATH, async () => {
    const all = await _loadAll();
    const g = all.find((x) => x.goal_id === goalId);
    if (!g) return;
    const m = g.milestones.find((x) => x.id === milestoneId);
    if (!m) return;
    m.reached = reached;
    if (reached) m.reached_at = _ts();
    await _saveAll(all);
    updated = m;
  });
  return updated;
}

// ── summary ────────────────────────────────────────────────────────────────

async function summary(workspace) {
  const all = await listGoals({ workspace });
  const active = all.filter((g) => g.status === 'active');
  const totalTasks = all.reduce((s, g) => s + g.tasks.length, 0);
  const completedTasks = all.reduce((s, g) => s + g.tasks.filter((t) => t.status === 'completed').length, 0);
  return {
    workspace: workspace || 'all',
    total: all.length,
    active: active.length,
    completed: all.filter((g) => g.status === 'completed').length,
    draft: all.filter((g) => g.status === 'draft').length,
    total_tasks: totalTasks,
    completed_tasks: completedTasks,
    goals: all.map((g) => ({
      goal_id: g.goal_id,
      title: g.title,
      status: g.status,
      task_progress: `${g.tasks.filter((t) => t.status === 'completed').length}/${g.tasks.length}`,
      created_at: g.created_at,
    })),
  };
}

module.exports = {
  createGoal, getGoal, listGoals, updateGoal, activateGoal, deleteGoal,
  updateTask, markMilestone, summary,
};
// ~235 lines

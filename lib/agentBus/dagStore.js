// DAG task system — persistent storage layer for the structured task graph.
//
// Sprint 31: New task system independent from the "letter" system (send_task/
// respond_task). Each DAG is a directed acyclic graph of task nodes, each
// with an executor + reviewer. Tasks flow through a strict state machine:
// pending → active → submitted → approved (or rejected → active).
//
// Persisted in ~/.boos/agent-bus.json under `dags` and `dag_tasks`.
// All writes serialize through withFileLock — same pattern as store.js.

'use strict';

const path = require('path');
const { withFileLock, atomicWriteJson } = require('../atomicJson');
const store = require('./store');

// ── helpers ──────────────────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

// ── validation ──────────────────────────────────────────────────────────

const VALID_STATUSES = new Set([
  'pending', 'active', 'submitted', 'approved', 'rejected', 'cancelled', 'escalated',
]);
const DAG_STATUSES = new Set(['draft', 'active', 'completed', 'cancelled']);

/**
 * Hardcoded constraint: executor and reviewer must be different agents.
 */
function validateExecutorReviewer(executorUid, reviewerUid) {
  if (!executorUid || !reviewerUid) {
    throw new Error('executor_uid and reviewer_uid are required');
  }
  if (executorUid === reviewerUid) {
    throw new Error(
      `executor and reviewer must be different agents (both are ${executorUid}). ` +
      'The executor/reviewer separation is a hard constraint of the DAG task system.'
    );
  }
}

/**
 * Detect circular dependencies in a DAG.
 */
function detectCycle(tasks, taskId, depId, visited = new Set()) {
  if (depId === taskId) return true;
  if (visited.has(depId)) return false;
  visited.add(depId);
  const dep = tasks[depId];
  if (!dep || !dep.dependencies) return false;
  for (const grandparent of dep.dependencies) {
    if (detectCycle(tasks, taskId, grandparent, visited)) return true;
  }
  return false;
}

/**
 * Validate all constraints on a task node before insertion.
 */
function validateTaskNode(tasks, task) {
  validateExecutorReviewer(task.executor_uid, task.reviewer_uid);

  if (task.dependencies && task.dependencies.includes(task.task_id)) {
    throw new Error(`task ${task.task_id} cannot depend on itself`);
  }

  if (task.dependencies) {
    for (const depId of task.dependencies) {
      if (!tasks[depId]) throw new Error(`dependency ${depId} not found in DAG`);
    }
  }

  if (task.dependencies) {
    for (const depId of task.dependencies) {
      if (detectCycle(tasks, task.task_id, depId)) {
        throw new Error(`circular dependency detected: ${task.task_id} <-> ${depId}`);
      }
    }
  }

  if (task.status && !VALID_STATUSES.has(task.status)) {
    throw new Error(`invalid task status: ${task.status}`);
  }
}

function genTaskId() { return 'dtask_' + require('node:crypto').randomUUID().slice(0, 8); }
function genDagId()  { return 'dag_'   + require('node:crypto').randomUUID().slice(0, 8); }

// ── DAG CRUD ────────────────────────────────────────────────────────────

async function createDag({ title, description, workspace, createdBy }) {
  if (!title || !workspace || !createdBy) throw new Error('title, workspace, and createdBy are required');

  const dagId = genDagId();
  const dag = {
    dag_id: dagId, title, description: description || '',
    requester: 'human', workspace, status: 'draft',
    created_by: createdBy, created_at: _now(), completed_at: null,
    task_count: 0, approved_count: 0,
  };

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    if (!db.dags) db.dags = {};
    if (!db.dag_tasks) db.dag_tasks = {};
    db.dags[dagId] = dag;
    await atomicWriteJson(store.DB_PATH, db);
  });

  return dag;
}

async function addTask(dagId, taskFields) {
  if (!dagId) throw new Error('dag_id is required');
  if (!taskFields.title) throw new Error('task title is required');
  if (!taskFields.acceptance_criteria) throw new Error('acceptance_criteria is required');

  const taskId = genTaskId();
  const task = {
    task_id: taskId, dag_id: dagId,
    title: taskFields.title,
    description: taskFields.description || '',
    executor_uid: taskFields.executor_uid,
    reviewer_uid: taskFields.reviewer_uid,
    dependencies: taskFields.dependencies || [],
    acceptance_criteria: taskFields.acceptance_criteria,
    status: 'pending',
    priority: taskFields.priority || 'normal',
    submit_content: null, submit_attachments: null,
    review_comment: null, review_history: [],
    retry_count: 0, max_retries: taskFields.max_retries || 3,
    created_at: _now(), activated_at: null,
    submitted_at: null, reviewed_at: null, completed_at: null,
  };

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();

    const dag = (db.dags || {})[dagId];
    if (!dag) throw new Error(`DAG ${dagId} not found`);
    if (dag.status !== 'draft') throw new Error(`DAG ${dagId} is not in draft status (current: ${dag.status})`);

    // Validate against existing tasks in this DAG.
    const dagTasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);
    const taskMap = {};
    for (const t of dagTasks) taskMap[t.task_id] = t;
    validateTaskNode(taskMap, task);

    // Verify executor and reviewer agents exist.
    if (task.executor_uid && !(db.agents || {})[task.executor_uid]) {
      throw new Error(`executor agent ${task.executor_uid} not found`);
    }
    if (task.reviewer_uid && !(db.agents || {})[task.reviewer_uid]) {
      throw new Error(`reviewer agent ${task.reviewer_uid} not found`);
    }

    if (!db.dag_tasks) db.dag_tasks = {};
    db.dag_tasks[taskId] = task;
    db.dags[dagId].task_count = (db.dags[dagId].task_count || 0) + 1;

    await atomicWriteJson(store.DB_PATH, db);
  });

  return task;
}

async function activateDag(dagId) {
  let readyTasks = [];

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const dag = (db.dags || {})[dagId];
    if (!dag) throw new Error(`DAG ${dagId} not found`);
    if (dag.status !== 'draft') throw new Error(`DAG ${dagId} is not in draft status (current: ${dag.status})`);

    dag.status = 'active';
    db.dags[dagId] = dag;

    const dagTasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);
    for (const t of dagTasks) {
      if (t.status !== 'pending') continue;
      const allDepsSatisfied = (t.dependencies || []).every((depId) => {
        const dep = db.dag_tasks[depId];
        return dep && dep.status === 'approved';
      });
      if (allDepsSatisfied) {
        t.status = 'active';
        t.activated_at = _now();
        db.dag_tasks[t.task_id] = t;
        readyTasks.push(t.task_id);
      }
    }

    await atomicWriteJson(store.DB_PATH, db);
  });

  return { dag_id: dagId, status: 'active', ready_tasks: readyTasks };
}

async function checkDagCompletion(dagId) {
  let completed = false;

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const dag = (db.dags || {})[dagId];
    if (!dag || dag.status !== 'active') return;

    const dagTasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);
    if (dagTasks.length === 0) return;
    if (dagTasks.every((t) => t.status === 'approved')) {
      dag.status = 'completed';
      dag.completed_at = _now();
      dag.approved_count = dagTasks.length;
      db.dags[dagId] = dag;
      completed = true;
      await atomicWriteJson(store.DB_PATH, db);
    }
  });

  return completed;
}

// ── task status mutations ────────────────────────────────────────────────

async function updateTaskStatus(taskId, newStatus, extraFields = {}) {
  if (!VALID_STATUSES.has(newStatus)) throw new Error(`invalid task status: ${newStatus}`);

  let updated;

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const task = (db.dag_tasks || {})[taskId];
    if (!task) throw new Error(`task ${taskId} not found`);

    task.status = newStatus;

    if (newStatus === 'active' && !task.activated_at) task.activated_at = _now();
    if (newStatus === 'submitted') task.submitted_at = _now();
    if (newStatus === 'approved' || newStatus === 'rejected') task.reviewed_at = _now();
    if (newStatus === 'approved') task.completed_at = _now();

    for (const [k, v] of Object.entries(extraFields)) {
      if (v !== undefined) task[k] = v;
    }

    // Record review actions in history. The `review_action` field allows
    // callers (e.g. rejectTask) to record a "rejected" action even when the
    // resulting status is 'active' (retry).
    const reviewAction = extraFields.review_action || newStatus;
    if (newStatus === 'approved' || newStatus === 'rejected' || extraFields.review_action) {
      if (!task.review_history) task.review_history = [];
      task.review_history.push({
        action: reviewAction,
        uid: extraFields.reviewer_uid || 'system',
        comment: extraFields.review_comment || '',
        timestamp: _now(),
      });
    }

    db.dag_tasks[taskId] = task;
    await atomicWriteJson(store.DB_PATH, db);
    updated = task;
  });

  // Post-commit: auto-unlock dependent tasks on approve.
  if (newStatus === 'approved' && updated) {
    await checkDagCompletion(updated.dag_id);
    await _unlockDependents(updated.dag_id, taskId);
  }

  return updated;
}

async function _unlockDependents(dagId, completedTaskId) {
  const newlyReady = [];

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const dagTasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);

    let changed = false;
    for (const t of dagTasks) {
      if (t.status !== 'pending') continue;
      if (!t.dependencies || !t.dependencies.includes(completedTaskId)) continue;
      const allDepsSatisfied = t.dependencies.every((depId) => {
        const dep = db.dag_tasks[depId];
        return dep && dep.status === 'approved';
      });
      if (allDepsSatisfied) {
        t.status = 'active';
        t.activated_at = _now();
        db.dag_tasks[t.task_id] = t;
        newlyReady.push(t.task_id);
        changed = true;
      }
    }

    if (changed) await atomicWriteJson(store.DB_PATH, db);
  });

  return newlyReady;
}

// ── queries ──────────────────────────────────────────────────────────────

function getDag(dagId) {
  const db = store._syncLoad();
  const dag = (db.dags || {})[dagId];
  if (!dag) return null;
  const tasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);
  return { ...dag, tasks };
}

function getTask(taskId) {
  const db = store._syncLoad();
  return (db.dag_tasks || {})[taskId] || null;
}

function listDags(workspace) {
  const db = store._syncLoad();
  return Object.values(db.dags || {}).filter((d) => d.workspace === workspace);
}

function getMyDagTasks(uid) {
  const db = store._syncLoad();
  const all = Object.values(db.dag_tasks || {});
  return {
    as_executor: all.filter((t) => t.executor_uid === uid),
    as_reviewer: all.filter((t) => t.reviewer_uid === uid),
  };
}

function getTasksByStatus(dagId, status) {
  const db = store._syncLoad();
  return Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId && t.status === status);
}

function getDagSummary(dagId) {
  const db = store._syncLoad();
  const tasks = Object.values(db.dag_tasks || {}).filter((t) => t.dag_id === dagId);
  const counts = { total: tasks.length, pending: 0, active: 0, submitted: 0, approved: 0, rejected: 0, cancelled: 0, escalated: 0 };
  for (const t of tasks) {
    if (counts[t.status] !== undefined) counts[t.status]++;
  }
  return counts;
}

// ── cancellation / escalation / reassignment ─────────────────────────────

async function cancelDag(dagId, reason) {
  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const dag = (db.dags || {})[dagId];
    if (!dag) throw new Error(`DAG ${dagId} not found`);
    if (dag.status === 'completed' || dag.status === 'cancelled') {
      throw new Error(`DAG ${dagId} is already ${dag.status}`);
    }

    dag.status = 'cancelled';
    db.dags[dagId] = dag;

    for (const [tid, t] of Object.entries(db.dag_tasks || {})) {
      if (t.dag_id === dagId && t.status !== 'approved' && t.status !== 'cancelled') {
        t.status = 'cancelled';
        t.review_comment = reason || 'DAG cancelled';
        db.dag_tasks[tid] = t;
      }
    }

    await atomicWriteJson(store.DB_PATH, db);
  });
}

async function cancelTask(taskId, reason) {
  return updateTaskStatus(taskId, 'cancelled', { review_comment: reason });
}

async function escalateTask(taskId, reason) {
  return updateTaskStatus(taskId, 'escalated', {
    review_comment: reason || 'exceeded max retry attempts',
  });
}

async function reassignTask(taskId, { newExecutorUid, newReviewerUid }) {
  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    const task = (db.dag_tasks || {})[taskId];
    if (!task) throw new Error(`task ${taskId} not found`);

    if (newExecutorUid) task.executor_uid = newExecutorUid;
    if (newReviewerUid) task.reviewer_uid = newReviewerUid;

    validateExecutorReviewer(task.executor_uid, task.reviewer_uid);

    if (task.status === 'escalated') {
      task.status = 'active';
      task.retry_count = 0;
      task.review_comment = null;
    }

    db.dag_tasks[taskId] = task;
    await atomicWriteJson(store.DB_PATH, db);
  });
}

module.exports = {
  createDag, addTask, activateDag, cancelDag, checkDagCompletion,
  updateTaskStatus, cancelTask, escalateTask, reassignTask,
  getDag, getTask, listDags, getMyDagTasks, getTasksByStatus, getDagSummary,
  validateExecutorReviewer, detectCycle, validateTaskNode,
  genTaskId, genDagId,
};

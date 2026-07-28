// Sprint 31 Phase 7: dagStore unit tests.
// Tests dagStore.js CRUD + validation logic.
//
// Run: node --test tests/dag-store.test.js

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── Setup ─────────────────────────────────────────────────────────────

let tmpBase;
let dagStore, store;

before(async () => {
  tmpBase = path.join(os.tmpdir(), 'boos-dagstore-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;

  // Clear caches so modules pick up new BOOS_HOME.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('agentBus') || k.includes('atomicJson') || k.includes('config'))
      delete require.cache[k];
  }

  store = require('../lib/agentBus/store');
  dagStore = require('../lib/agentBus/dagStore');

  // Register test agents needed by addTask validation.
  await store.insertAgent({ uid: 'exec_01', name: 'Executor-1', intro: '', workspace: 'boos', role: 'worker', capabilities: [] });
  await store.insertAgent({ uid: 'revi_01', name: 'Reviewer-1', intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
  await store.insertAgent({ uid: 'exec_02', name: 'Executor-2', intro: '', workspace: 'boos', role: 'worker', capabilities: [] });
  await store.insertAgent({ uid: 'revi_02', name: 'Reviewer-2', intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
  await store.insertAgent({ uid: 'pm_01',    name: 'PM',        intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── Helpers ────────────────────────────────────────────────────────────

async function createTestDag(title) {
  return dagStore.createDag({ title: title || 'Test DAG', workspace: 'boos', createdBy: 'pm_01' });
}

async function addTaskTo(dagId, overrides = {}) {
  return dagStore.addTask(dagId, {
    title: overrides.title || 'Test Task',
    description: overrides.description || '',
    executor_uid: overrides.executor_uid || 'exec_01',
    reviewer_uid: overrides.reviewer_uid || 'revi_01',
    dependencies: overrides.dependencies || [],
    acceptance_criteria: overrides.acceptance_criteria || 'Must pass tests',
    priority: overrides.priority || 'normal',
  });
}

// ═══════════════════════════════════════════════════════════════════════
// createDag
// ═══════════════════════════════════════════════════════════════════════

describe('createDag', () => {
  test('creates a draft DAG with correct defaults', async () => {
    const dag = await createTestDag('Sprint 31 QA');
    assert.ok(dag.dag_id.startsWith('dag_'));
    assert.equal(dag.title, 'Sprint 31 QA');
    assert.equal(dag.status, 'draft');
    assert.equal(dag.workspace, 'boos');
    assert.equal(dag.task_count, 0);
    assert.equal(dag.approved_count, 0);
    assert.ok(dag.created_at);
    assert.equal(dag.completed_at, null);
  });

  test('throws when title is missing', async () => {
    await assert.rejects(
      () => dagStore.createDag({ workspace: 'boos', createdBy: 'pm_01' }),
      /title.*required/i,
    );
  });

  test('throws when workspace is missing', async () => {
    await assert.rejects(
      () => dagStore.createDag({ title: 'X', createdBy: 'pm_01' }),
      /workspace.*required/i,
    );
  });

  test('throws when createdBy is missing', async () => {
    await assert.rejects(
      () => dagStore.createDag({ title: 'X', workspace: 'boos' }),
      /createdBy.*required/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// addTask
// ═══════════════════════════════════════════════════════════════════════

describe('addTask', () => {
  let dag;

  before(async () => { dag = await createTestDag('AddTask DAG'); });

  test('adds a task to a draft DAG', async () => {
    const t = await addTaskTo(dag.dag_id, { title: 'Write unit tests' });
    assert.ok(t.task_id.startsWith('dtask_'));
    assert.equal(t.title, 'Write unit tests');
    assert.equal(t.status, 'pending');
    assert.equal(t.dag_id, dag.dag_id);
    assert.equal(t.priority, 'normal');
    assert.equal(t.max_retries, 3);
  });

  test('task_count increments', async () => {
    const d = dagStore.getDag(dag.dag_id);
    assert.equal(d.task_count, 1);
  });

  test('throws when executor == reviewer', async () => {
    await assert.rejects(
      () => addTaskTo(dag.dag_id, { executor_uid: 'exec_01', reviewer_uid: 'exec_01' }),
      /executor and reviewer must be different/i,
    );
  });

  test('throws when DAG not found', async () => {
    await assert.rejects(
      () => addTaskTo('dag_nonexistent'),
      /not found/i,
    );
  });

  test('throws when DAG is active (not draft)', async () => {
    const dag2 = await createTestDag('Active-check DAG');
    await dagStore.activateDag(dag2.dag_id);
    await assert.rejects(
      () => addTaskTo(dag2.dag_id),
      /not in draft status/i,
    );
  });

  test('throws on missing acceptance_criteria', async () => {
    await assert.rejects(
      () => dagStore.addTask(dag.dag_id, { title: 'X', executor_uid: 'exec_01', reviewer_uid: 'revi_01', dependencies: [], acceptance_criteria: '' }),
      /acceptance_criteria.*required/i,
    );
  });

  test('throws on circular dependency', async () => {
    await assert.rejects(
      () => addTaskTo(dag.dag_id, { title: 'Circular test', dependencies: ['dtask_nonexistent'] }),
      /not found in DAG/i,
    );
  });

  test('throws on executor agent not found', async () => {
    await assert.rejects(
      () => addTaskTo(dag.dag_id, { executor_uid: 'agent_ghost', reviewer_uid: 'revi_01' }),
      /executor agent.*not found/i,
    );
  });

  test('throws on reviewer agent not found', async () => {
    await assert.rejects(
      () => addTaskTo(dag.dag_id, { executor_uid: 'exec_01', reviewer_uid: 'agent_ghost' }),
      /reviewer agent.*not found/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// activateDag
// ═══════════════════════════════════════════════════════════════════════

describe('activateDag', () => {
  test('transitions draft → active, activates zero-dep tasks', async () => {
    const dag = await createTestDag('Activation DAG');
    const t1 = await addTaskTo(dag.dag_id, { title: 'Task 1 (no deps)', dependencies: [] });
    const t2 = await addTaskTo(dag.dag_id, { title: 'Task 2 (depends on T1)', dependencies: [t1.task_id], executor_uid: 'exec_02', reviewer_uid: 'revi_02' });

    const result = await dagStore.activateDag(dag.dag_id);
    assert.equal(result.status, 'active');

    const dag2 = dagStore.getDag(dag.dag_id);
    assert.equal(dag2.status, 'active');

    // Task 1 (no deps) → active; Task 2 (has deps) → still pending.
    const t1a = dagStore.getTask(t1.task_id);
    const t2a = dagStore.getTask(t2.task_id);
    assert.equal(t1a.status, 'active');
    assert.ok(t1a.activated_at);
    assert.equal(t2a.status, 'pending');
    assert.equal(t2a.activated_at, null);
  });

  test('throws when DAG is not draft', async () => {
    const dag = await createTestDag('Already Active');
    await dagStore.activateDag(dag.dag_id);
    await assert.rejects(
      () => dagStore.activateDag(dag.dag_id),
      /not in draft status/i,
    );
  });

  test('all zero-dep tasks become active', async () => {
    const dag = await createTestDag('Multi-activate');
    const t1 = await addTaskTo(dag.dag_id, { title: 'A' });
    const t2 = await addTaskTo(dag.dag_id, { title: 'B', executor_uid: 'exec_02', reviewer_uid: 'revi_02' });
    const result = await dagStore.activateDag(dag.dag_id);
    assert.equal(result.ready_tasks.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// updateTaskStatus
// ═══════════════════════════════════════════════════════════════════════

describe('updateTaskStatus', () => {
  test('pending → active → submitted → approved flow', async () => {
    const dag = await createTestDag('Flow DAG');
    const task = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);

    let t = dagStore.getTask(task.task_id);
    assert.equal(t.status, 'active');

    t = await dagStore.updateTaskStatus(task.task_id, 'submitted', { submit_content: 'Done' });
    assert.equal(t.status, 'submitted');
    assert.ok(t.submitted_at);

    t = await dagStore.updateTaskStatus(task.task_id, 'approved', { review_comment: 'LGTM' });
    assert.equal(t.status, 'approved');
    assert.ok(t.reviewed_at);
    assert.ok(t.completed_at);
    assert.equal(t.review_history.length, 1);
    assert.equal(t.review_history[0].action, 'approved');
  });

  test('throws on invalid status', async () => {
    const dag = await createTestDag('BadStatus DAG');
    const task = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);

    await assert.rejects(
      () => dagStore.updateTaskStatus(task.task_id, 'invalid_status'),
      /invalid task status/i,
    );
  });

  test('rejected has review_history', async () => {
    const dag = await createTestDag('Reject DAG');
    const task = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);

    await dagStore.updateTaskStatus(task.task_id, 'submitted');
    const r = await dagStore.updateTaskStatus(task.task_id, 'rejected', { review_comment: 'Needs fix', submit_content: 'retry' });
    assert.equal(r.status, 'rejected');
    assert.ok(r.reviewed_at);
    assert.ok(r.review_history.some(h => h.action === 'rejected'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// checkDagCompletion
// ═══════════════════════════════════════════════════════════════════════

describe('checkDagCompletion', () => {
  test('marks DAG completed when all tasks approved', async () => {
    const dag = await createTestDag('Completion DAG');
    const t = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);
    await dagStore.updateTaskStatus(t.task_id, 'submitted');
    await dagStore.updateTaskStatus(t.task_id, 'approved');

    const d = dagStore.getDag(dag.dag_id);
    assert.equal(d.status, 'completed');
    assert.ok(d.completed_at);
    assert.equal(d.approved_count, 1);
  });

  test('does not complete when tasks remain', async () => {
    const dag = await createTestDag('Partial DAG');
    await addTaskTo(dag.dag_id, { title: 'T1' });
    await addTaskTo(dag.dag_id, { title: 'T2', executor_uid: 'exec_02', reviewer_uid: 'revi_02' });
    await dagStore.activateDag(dag.dag_id);

    const d = dagStore.getDag(dag.dag_id);
    assert.equal(d.status, 'active'); // not completed
  });
});

// ═══════════════════════════════════════════════════════════════════════
// cancelDag / cancelTask
// ═══════════════════════════════════════════════════════════════════════

describe('cancelDag / cancelTask', () => {
  test('cancelDag sets DAG + all non-approved tasks to cancelled', async () => {
    const dag = await createTestDag('Cancel DAG');
    const t1 = await addTaskTo(dag.dag_id, { title: 'T1' });
    const t2 = await addTaskTo(dag.dag_id, { title: 'T2', executor_uid: 'exec_02', reviewer_uid: 'revi_02' });
    await dagStore.activateDag(dag.dag_id);

    await dagStore.cancelDag(dag.dag_id, 'Deprecated');
    const d = dagStore.getDag(dag.dag_id);
    assert.equal(d.status, 'cancelled');

    assert.equal(dagStore.getTask(t1.task_id).status, 'cancelled');
    assert.equal(dagStore.getTask(t2.task_id).status, 'cancelled');
  });

  test('cancelTask cancels a single task', async () => {
    const dag = await createTestDag('Cancel Task DAG');
    const t = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);

    await dagStore.cancelTask(t.task_id, 'No longer needed');
    assert.equal(dagStore.getTask(t.task_id).status, 'cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// escalateTask / reassignTask
// ═══════════════════════════════════════════════════════════════════════

describe('escalateTask / reassignTask', () => {
  test('escalateTask sets status to escalated', async () => {
    const dag = await createTestDag('Escalate DAG');
    const t = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);

    const result = await dagStore.escalateTask(t.task_id, '3 retries exhausted');
    assert.equal(result.status, 'escalated');
  });

  test('reassignTask updates executor/reviewer and resets escalated', async () => {
    const dag = await createTestDag('Reassign DAG');
    const t = await addTaskTo(dag.dag_id);
    await dagStore.activateDag(dag.dag_id);
    await dagStore.escalateTask(t.task_id);

    await dagStore.reassignTask(t.task_id, { newExecutorUid: 'exec_02', newReviewerUid: 'revi_02' });
    const updated = dagStore.getTask(t.task_id);
    assert.equal(updated.executor_uid, 'exec_02');
    assert.equal(updated.reviewer_uid, 'revi_02');
    assert.equal(updated.status, 'active'); // escalated → active
    assert.equal(updated.retry_count, 0);
  });

  test('reassignTask validates executor ≠ reviewer', async () => {
    const dag = await createTestDag('Reassign-valid DAG');
    const t = await addTaskTo(dag.dag_id);
    await assert.rejects(
      () => dagStore.reassignTask(t.task_id, { newExecutorUid: 'exec_01', newReviewerUid: 'exec_01' }),
      /executor and reviewer must be different/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════════════

describe('queries', () => {
  let dag;

  before(async () => {
    dag = await createTestDag('Query DAG');
    await addTaskTo(dag.dag_id, { title: 'Q1' });
    await addTaskTo(dag.dag_id, { title: 'Q2', executor_uid: 'exec_02', reviewer_uid: 'revi_02' });
  });

  test('getDag returns dag with tasks array', () => {
    const d = dagStore.getDag(dag.dag_id);
    assert.ok(d);
    assert.equal(d.tasks.length, 2);
  });

  test('getTask returns single task', () => {
    const tasks = dagStore.getDag(dag.dag_id).tasks;
    const t = dagStore.getTask(tasks[0].task_id);
    assert.ok(t);
    assert.equal(t.dag_id, dag.dag_id);
  });

  test('listDags filters by workspace', () => {
    const dags = dagStore.listDags('boos');
    assert.ok(dags.length >= 1);
    assert.ok(dags.every(d => d.workspace === 'boos'));
  });

  test('getMyDagTasks returns executor and reviewer tasks', () => {
    const result = dagStore.getMyDagTasks('exec_01');
    assert.ok(result.as_executor.length >= 1);
  });

  test('getDagSummary counts correctly', () => {
    const s = dagStore.getDagSummary(dag.dag_id);
    assert.equal(s.total, 2);
    assert.equal(s.pending, 2);
    assert.equal(s.approved, 0);
  });
});

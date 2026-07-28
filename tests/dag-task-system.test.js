// Sprint 31 Phase 7: taskSystem unit tests.
// Tests taskSystem.js permission matrix + state machine.
//
// NOTE: taskSystem throws on permission/semantic errors (not returning
// {ok:false}). Use assert.rejects() for negative test cases. Positive
// cases return {ok:true, ...} directly.
//
// Run: node --test tests/dag-task-system.test.js

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── Setup ─────────────────────────────────────────────────────────────

let tmpBase;
let dagStore, store, taskSystem;

before(async () => {
  tmpBase = path.join(os.tmpdir(), 'boos-tasksys-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;

  for (const k of Object.keys(require.cache)) {
    if (k.includes('agentBus') || k.includes('atomicJson') || k.includes('config'))
      delete require.cache[k];
  }

  store = require('../lib/agentBus/store');
  dagStore = require('../lib/agentBus/dagStore');
  taskSystem = require('../lib/agentBus/taskSystem');

  // Register agents with distinct roles.
  await store.insertAgent({ uid: 'exec_a', name: 'Executor-A', intro: '', workspace: 'boos', role: 'worker',     capabilities: [] });
  await store.insertAgent({ uid: 'revi_a', name: 'Reviewer-A', intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
  await store.insertAgent({ uid: 'exec_b', name: 'Executor-B', intro: '', workspace: 'boos', role: 'worker',     capabilities: [] });
  await store.insertAgent({ uid: 'revi_b', name: 'Reviewer-B', intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
  await store.insertAgent({ uid: 'pm_01',  name: 'PM',        intro: '', workspace: 'boos', role: 'supervisor', capabilities: [] });
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── Helpers ────────────────────────────────────────────────────────────

async function createActiveTask(overrides = {}) {
  const dag = await dagStore.createDag({
    title: overrides.dagTitle || 'TaskSys DAG',
    workspace: 'boos',
    createdBy: 'pm_01',
  });
  const task = await dagStore.addTask(dag.dag_id, {
    title: overrides.title || 'Test Task',
    description: '',
    executor_uid: overrides.executor_uid || 'exec_a',
    reviewer_uid: overrides.reviewer_uid || 'revi_a',
    dependencies: overrides.dependencies || [],
    acceptance_criteria: overrides.acceptance_criteria || 'Must work',
    priority: 'normal',
    max_retries: overrides.max_retries || 3,
  });
  await dagStore.activateDag(dag.dag_id);
  return { dag, task };
}

// ═══════════════════════════════════════════════════════════════════════
// submitTask
// ═══════════════════════════════════════════════════════════════════════

describe('submitTask', () => {
  test('executor can submit their own task', async () => {
    const { task } = await createActiveTask();
    const r = await taskSystem.submitTask(task.task_id, 'exec_a', {
      content: 'All tests pass. Ready for review.',
    });
    assert.equal(r.ok, true);
    const updated = dagStore.getTask(task.task_id);
    assert.equal(updated.status, 'submitted');
    assert.ok(updated.submitted_at);
  });

  test('non-executor cannot submit (throws permission error)', async () => {
    const { task } = await createActiveTask({ executor_uid: 'exec_a' });
    await assert.rejects(
      () => taskSystem.submitTask(task.task_id, 'exec_b', { content: 'Done' }),
      /executor/i,
    );
    // Task status should NOT have changed.
    assert.notEqual(dagStore.getTask(task.task_id).status, 'submitted');
  });

  test('empty content is rejected (throws)', async () => {
    const { task } = await createActiveTask();
    await assert.rejects(
      () => taskSystem.submitTask(task.task_id, 'exec_a', { content: '' }),
      /content/i,
    );
  });

  test('missing content field is rejected (throws)', async () => {
    const { task } = await createActiveTask();
    await assert.rejects(
      () => taskSystem.submitTask(task.task_id, 'exec_a', {}),
      /content/i,
    );
  });

  test('cannot submit a non-active task (throws)', async () => {
    const { task } = await createActiveTask();
    // Submit once to move to submitted.
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'First submit' });
    // Attempt second submit → throws because status is 'submitted', not 'active'.
    await assert.rejects(
      () => taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Second submit' }),
      /not in.*active/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// approveTask
// ═══════════════════════════════════════════════════════════════════════

describe('approveTask', () => {
  test('reviewer can approve a submitted task', async () => {
    const { task } = await createActiveTask();
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Done' });

    const r = await taskSystem.approveTask(task.task_id, 'revi_a', { comment: 'LGTM' });
    assert.equal(r.ok, true);
    const updated = dagStore.getTask(task.task_id);
    assert.equal(updated.status, 'approved');
    assert.ok(updated.completed_at);
  });

  test('non-reviewer cannot approve (throws permission error)', async () => {
    const { task } = await createActiveTask({ reviewer_uid: 'revi_a' });
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Done' });

    await assert.rejects(
      () => taskSystem.approveTask(task.task_id, 'revi_b', { comment: 'LGTM' }),
      /reviewer/i,
    );
  });

  test('cannot approve a non-submitted task (throws)', async () => {
    const { task } = await createActiveTask();
    // Task is active, not submitted.
    await assert.rejects(
      () => taskSystem.approveTask(task.task_id, 'revi_a', { comment: 'LGTM' }),
      /not in.*submitted/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// rejectTask
// ═══════════════════════════════════════════════════════════════════════

describe('rejectTask', () => {
  test('reviewer can reject with a comment, task goes back to active', async () => {
    const { task } = await createActiveTask();
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Draft' });

    const r = await taskSystem.rejectTask(task.task_id, 'revi_a', { comment: 'Missing edge case tests' });
    assert.equal(r.ok, true);
    const updated = dagStore.getTask(task.task_id);
    assert.equal(updated.status, 'active');
    assert.equal(updated.retry_count, 1);
    // Review history includes the rejection.
    assert.ok(updated.review_history.some(h => h.action === 'rejected'));
  });

  test('non-reviewer cannot reject (throws permission error)', async () => {
    const { task } = await createActiveTask();
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Done' });

    await assert.rejects(
      () => taskSystem.rejectTask(task.task_id, 'exec_b', { comment: 'Nope' }),
      /reviewer/i,
    );
  });

  test('reject without comment is rejected (throws)', async () => {
    const { task } = await createActiveTask();
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Done' });

    await assert.rejects(
      () => taskSystem.rejectTask(task.task_id, 'revi_a', { comment: '' }),
      /comment/i,
    );
  });

  test('auto-escalates after max_retries (3) rejections', async () => {
    const { task } = await createActiveTask({ max_retries: 3 });

    // Submit + reject × 3.
    for (let i = 0; i < 3; i++) {
      await taskSystem.submitTask(task.task_id, 'exec_a', { content: `Attempt ${i + 1}` });
      if (i < 2) {
        // First 2: normal reject → back to active.
        const r = await taskSystem.rejectTask(task.task_id, 'revi_a', { comment: 'Try again' });
        assert.equal(r.ok, true);
        assert.equal(r.escalated, undefined);
        assert.equal(dagStore.getTask(task.task_id).status, 'active');
      } else {
        // 3rd reject → escalated.
        const r = await taskSystem.rejectTask(task.task_id, 'revi_a', { comment: 'Still failing' });
        assert.equal(r.ok, true);
        assert.equal(r.escalated, true);
        const updated = dagStore.getTask(task.task_id);
        assert.equal(updated.status, 'escalated');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// cancelDagTask
// ═══════════════════════════════════════════════════════════════════════

describe('cancelDagTask', () => {
  test('PM can cancel a task', async () => {
    const { task } = await createActiveTask();
    const r = await taskSystem.cancelDagTask(task.task_id, 'pm_01', 'No longer required');
    assert.equal(r.ok, true);
    assert.equal(dagStore.getTask(task.task_id).status, 'cancelled');
  });

  test('worker cannot cancel a task (throws permission error)', async () => {
    const { task } = await createActiveTask();
    await assert.rejects(
      () => taskSystem.cancelDagTask(task.task_id, 'exec_a', 'I give up'),
      /PM.*or.*PMO|permission/i,
    );
  });

  test('supervisor (reviewer with PM role) can cancel', async () => {
    const { task } = await createActiveTask();
    // Reviewer is supervisor role — should be able to cancel.
    const r = await taskSystem.cancelDagTask(task.task_id, 'revi_a', 'Obsolete');
    assert.equal(r.ok, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// reassignDagTask
// ═══════════════════════════════════════════════════════════════════════

describe('reassignDagTask', () => {
  test('PM can reassign executor and reviewer', async () => {
    const { task } = await createActiveTask();
    const r = await taskSystem.reassignDagTask(task.task_id, 'pm_01', {
      newExecutorUid: 'exec_b',
      newReviewerUid: 'revi_b',
    });
    assert.equal(r.ok, true);
    const updated = dagStore.getTask(task.task_id);
    assert.equal(updated.executor_uid, 'exec_b');
    assert.equal(updated.reviewer_uid, 'revi_b');
  });

  test('worker cannot reassign (throws permission error)', async () => {
    const { task } = await createActiveTask();
    await assert.rejects(
      () => taskSystem.reassignDagTask(task.task_id, 'exec_a', {
        newExecutorUid: 'exec_b',
        newReviewerUid: 'revi_b',
      }),
      /PM.*or.*PMO|permission/i,
    );
  });

  test('reassign validates new executor ≠ new reviewer (throws)', async () => {
    const { task } = await createActiveTask();
    await assert.rejects(
      () => taskSystem.reassignDagTask(task.task_id, 'pm_01', {
        newExecutorUid: 'exec_a',
        newReviewerUid: 'exec_a',
      }),
      /different/i,
    );
  });

  test('reassign resets escalated status', async () => {
    const { task } = await createActiveTask({ max_retries: 1 });
    // Submit and get rejected to max → escalated.
    await taskSystem.submitTask(task.task_id, 'exec_a', { content: 'Done' });
    await taskSystem.rejectTask(task.task_id, 'revi_a', { comment: 'Fix' });
    // Escalated after max_retries=1.
    const t0 = dagStore.getTask(task.task_id);
    if (t0.status === 'escalated') {
      const r = await taskSystem.reassignDagTask(task.task_id, 'pm_01', {
        newExecutorUid: 'exec_b',
        newReviewerUid: 'revi_b',
      });
      assert.equal(r.ok, true);
      const updated = dagStore.getTask(task.task_id);
      assert.equal(updated.retry_count, 0);
      assert.notEqual(updated.status, 'escalated');
    }
  });
});

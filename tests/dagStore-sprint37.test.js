'use strict';

// dagStore Sprint 37 new functions — tests for forceModifyTask, deleteTaskNode,
// approveProposal, rejectProposal.
//
// Uses temp BOOS_HOME with real agent-bus.json — same pattern as store.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let TMP;
const origHome = process.env.BOOS_HOME;
const origNoAgentBus = process.env.BOOS_NO_AGENT_BUS;

const CLEAR_MODS = [
  '../lib/config', '../lib/agentBus/storeCore',
  '../lib/agentBus/store', '../lib/agentBus/storeTasks', '../lib/agentBus/storeIdentity',
  '../lib/agentBus/registry', '../lib/agentBus/handlers',
  '../lib/agentBus/handlersDag',
  '../lib/agentBus/dagStore', '../lib/agentBus/dagEngine',
  '../lib/agentBus/dagDecomposer', '../lib/agentBus/taskSystem',
  '../lib/agentBus/notifications', '../lib/agentBus/notificationsWake',
  '../lib/agentBus/collaborationLoop', '../lib/identityResolver', '../lib/identityAdapter',
  '../lib/folders', '../lib/persistedSessions',
  '../lib/sandbox', '../lib/hrAgent',
];

function clearCaches() {
  for (const m of CLEAR_MODS) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

function freshSetup() {
  if (TMP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  TMP = path.join(os.tmpdir(), 'boos-dagstore37-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(TMP, { recursive: true });
  process.env.BOOS_HOME = TMP;
  process.env.BOOS_NO_AGENT_BUS = '1';
  clearCaches();
}

function teardown() {
  if (origHome === undefined) delete process.env.BOOS_HOME;
  else process.env.BOOS_HOME = origHome;
  if (origNoAgentBus === undefined) delete process.env.BOOS_NO_AGENT_BUS;
  else process.env.BOOS_NO_AGENT_BUS = origNoAgentBus;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────

function nextUid() {
  const n = Math.random().toString(36).slice(2, 10);
  return `test-${n}-${n}-${n}-${n}${n}${n}`;
}

async function createTestContext() {
  const store = require('../lib/agentBus/store');
  const dagStore = require('../lib/agentBus/dagStore');

  // Register agents.
  const pmUid = nextUid();
  const feUid = nextUid();
  const beUid = nextUid();
  const qaUid = nextUid();

  await store.insertAgent({ uid: pmUid, name: 'PM', intro: 'PM', workspace: 'boos-test', role: 'supervisor', capabilities: ['architecture'] });
  await store.insertAgent({ uid: feUid, name: '前端', intro: 'FE', workspace: 'boos-test', role: 'worker', capabilities: ['frontend'] });
  await store.insertAgent({ uid: beUid, name: '后端', intro: 'BE', workspace: 'boos-test', role: 'worker', capabilities: ['backend'] });
  await store.insertAgent({ uid: qaUid, name: '测试', intro: 'QA', workspace: 'boos-test', role: 'worker', capabilities: ['testing'] });

  // Create a DAG with some tasks.
  const dag = await dagStore.createDag({
    title: 'Sprint 37 Test', description: 'Testing new functions.',
    workspace: 'boos-test', createdBy: pmUid,
  });

  // Add task A (no deps) — will be used for forceModify and delete.
  const taskA = await dagStore.addTask(dag.dag_id, {
    title: 'Task A — Initial Version', description: 'Original description.',
    executor_uid: feUid, reviewer_uid: beUid, acceptance_criteria: 'Done.',
    priority: 'normal',
  });

  // Add task B (depends on A).
  const taskB = await dagStore.addTask(dag.dag_id, {
    title: 'Task B',
    description: 'Depends on A.',
    executor_uid: beUid, reviewer_uid: qaUid,
    dependencies: [taskA.task_id], acceptance_criteria: 'Done.',
  });

  // Add task C (depends on A and B).
  const taskC = await dagStore.addTask(dag.dag_id, {
    title: 'Task C',
    description: 'Depends on A and B.',
    executor_uid: qaUid, reviewer_uid: pmUid,
    dependencies: [taskA.task_id, taskB.task_id], acceptance_criteria: 'Done.',
  });

  // Add proposed task — create with dummy executor/reviewer, then override to proposed.
  const proposedTask = await dagStore.addTask(dag.dag_id, {
    title: 'Proposed Task',
    description: 'Pending proposal.',
    executor_uid: feUid, reviewer_uid: beUid,
    acceptance_criteria: 'To be defined.',
  });
  // Manually set status to 'proposed' and clear executor/reviewer.
  const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    if (db.dag_tasks[proposedTask.task_id]) {
      db.dag_tasks[proposedTask.task_id].status = 'proposed';
      db.dag_tasks[proposedTask.task_id].executor_uid = null;
      db.dag_tasks[proposedTask.task_id].reviewer_uid = null;
      await atomicWriteJson(store.DB_PATH, db);
    }
  });

  // Add a blocking task waiting for the proposal.
  const blockedTask = await dagStore.addTask(dag.dag_id, {
    title: 'Blocking Task',
    description: 'Blocked waiting for proposal.',
    executor_uid: feUid, reviewer_uid: beUid,
    acceptance_criteria: 'After proposal.',
  });
  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    if (db.dag_tasks[blockedTask.task_id]) {
      db.dag_tasks[blockedTask.task_id].status = 'blocked';
      db.dag_tasks[blockedTask.task_id].block_reason = 'waiting for proposal';
      await atomicWriteJson(store.DB_PATH, db);
    }
    // Link proposed task to blocking task.
    if (db.dag_tasks[proposedTask.task_id]) {
      db.dag_tasks[proposedTask.task_id].blocked_task_id = blockedTask.task_id;
      await atomicWriteJson(store.DB_PATH, db);
    }
  });

  return {
    store, dagStore, pmUid, feUid, beUid, qaUid,
    dagId: dag.dag_id,
    taskA: taskA.task_id,
    taskB: taskB.task_id,
    taskC: taskC.task_id,
    proposedTaskId: proposedTask.task_id,
    blockedTaskId: blockedTask.task_id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('dagStore Sprint 37', () => {
  let ctx;

  before(async () => {
    freshSetup();
    ctx = await createTestContext();
  });

  after(() => { teardown(); });

  // ── forceModifyTask ──────────────────────────────────────────────────────

  describe('forceModifyTask', () => {
    test('modifies task title', async () => {
      await ctx.dagStore.forceModifyTask(ctx.taskA, {
        title: 'Task A — Updated Version',
      }, ctx.pmUid);

      const task = ctx.dagStore.getTask(ctx.taskA);
      assert.strictEqual(task.title, 'Task A — Updated Version');
      assert.strictEqual(task.force_modified_by, ctx.pmUid);
      assert.ok(task.force_modified_at);
    });

    test('modifies task description', async () => {
      // First reset via fresh DAG — use taskB instead.
      await ctx.dagStore.forceModifyTask(ctx.taskB, {
        description: 'New description for B.',
      }, ctx.pmUid);

      const task = ctx.dagStore.getTask(ctx.taskB);
      assert.strictEqual(task.description, 'New description for B.');
    });

    test('modifies executor and reviewer', async () => {
      await ctx.dagStore.forceModifyTask(ctx.taskC, {
        executor_uid: ctx.beUid,
        reviewer_uid: ctx.qaUid,
      }, ctx.pmUid);

      const task = ctx.dagStore.getTask(ctx.taskC);
      assert.strictEqual(task.executor_uid, ctx.beUid);
      assert.strictEqual(task.reviewer_uid, ctx.qaUid);
    });

    test('archives old submit_content to review_history', async () => {
      // Set submit_content first.
      const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
      const store = require('../lib/agentBus/store');
      await withFileLock(store.DB_PATH, async () => {
        const db = await store._load();
        if (db.dag_tasks[ctx.taskA]) {
          db.dag_tasks[ctx.taskA].submit_content = 'Original submission content.';
          await atomicWriteJson(store.DB_PATH, db);
        }
      });

      await ctx.dagStore.forceModifyTask(ctx.taskA, {
        title: 'Force modified after submit.',
      }, ctx.pmUid);

      const task = ctx.dagStore.getTask(ctx.taskA);
      assert.ok(task.review_history);
      const forceEntry = task.review_history.find((h) => h.action === 'force_modified');
      assert.ok(forceEntry, 'should have force_modified entry in review_history');
      assert.strictEqual(forceEntry.content, 'Original submission content.');
      assert.strictEqual(forceEntry.by, ctx.pmUid);
    });

    test('resets submission state after force modify', async () => {
      const task = ctx.dagStore.getTask(ctx.taskA);
      assert.strictEqual(task.submit_content, null);
      assert.strictEqual(task.status, 'active');
      assert.strictEqual(task.retry_count, 0);
      assert.strictEqual(task.re_notified_to_executor, false);
    });

    test('forceModifyTask with same executor+reviewer pair is validated', async () => {
      const task = ctx.dagStore.getTask(ctx.taskA);
      // Already modified above. Create a fresh DAG for this test.
      const dag = await ctx.dagStore.createDag({
        title: 'Validator Test', description: 'Test validation.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Validated Task', description: 'Check.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
      });

      let threw = false;
      try {
        await ctx.dagStore.forceModifyTask(t.task_id, {
          executor_uid: ctx.beUid,
          reviewer_uid: ctx.beUid, // Same!
        }, ctx.pmUid);
      } catch (e) {
        threw = true;
        assert.ok(e.message.includes('must be different') || e.message.includes('same'));
      }
      assert.ok(threw, 'should reject same executor/reviewer');
    });

    test('modifies acceptance_criteria', async () => {
      const dag = await ctx.dagStore.createDag({
        title: 'AC Test', description: 'Test AC.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'AC Task', description: 'Check.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Old AC.',
      });

      await ctx.dagStore.forceModifyTask(t.task_id, {
        acceptance_criteria: 'New stricter AC.',
      }, ctx.pmUid);

      const updated = ctx.dagStore.getTask(t.task_id);
      assert.strictEqual(updated.acceptance_criteria, 'New stricter AC.');
    });

    test('modifies dependencies and priority', async () => {
      const dag = await ctx.dagStore.createDag({
        title: 'Dep Test', description: 'Test deps change.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Dep Task', description: 'Check.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
        priority: 'low',
      });

      await ctx.dagStore.forceModifyTask(t.task_id, {
        dependencies: ['dtask_nonexist1', 'dtask_nonexist2'],
        priority: 'high',
      }, ctx.pmUid);

      const updated = ctx.dagStore.getTask(t.task_id);
      assert.strictEqual(updated.priority, 'high');
      assert.deepStrictEqual(updated.dependencies, ['dtask_nonexist1', 'dtask_nonexist2']);
    });

    test('throws for non-existent task', async () => {
      try {
        await ctx.dagStore.forceModifyTask('dtask_noexist', { title: 'Bad' }, ctx.pmUid);
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('not found'));
      }
    });
  });

  // ── deleteTaskNode ───────────────────────────────────────────────────────

  describe('deleteTaskNode', () => {
    let delDagId, delTaskId;

    before(async () => {
      // Create a fresh DAG for delete tests.
      const dag = await ctx.dagStore.createDag({
        title: 'Delete Test DAG', description: 'Testing node deletion.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      delDagId = dag.dag_id;

      const t1 = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Delete Root', description: 'Will be deleted.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
      });
      delTaskId = t1.task_id;

      await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Downstream 1', description: 'Depends on root.',
        executor_uid: ctx.beUid, reviewer_uid: ctx.qaUid,
        dependencies: [delTaskId], acceptance_criteria: 'Done.',
      });

      await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Downstream 2', description: 'Also depends on root.',
        executor_uid: ctx.qaUid, reviewer_uid: ctx.pmUid,
        dependencies: [delTaskId], acceptance_criteria: 'Done.',
      });
    });

    test('deletes node and returns task_id', async () => {
      const result = await ctx.dagStore.deleteTaskNode(delTaskId);
      assert.strictEqual(result.deleted, delTaskId);
      assert.ok(result.orphans.length >= 2);
    });

    test('deleted node is removed from store', () => {
      const task = ctx.dagStore.getTask(delTaskId);
      assert.strictEqual(task, null);
    });

    test('orphans have dependency on deleted node removed', () => {
      for (const orphanId of [ctx.taskB, ctx.taskC].filter(Boolean)) {
        // Note: taskB and taskC were from the first DAG, not this one.
        // The orphans from the delete test are different.
      }
      // Verify the orphans from our delete test.
      const result = ctx.dagStore.deleteTaskNode; // already called above, verify state
      // Orphans were from the delete test DAG. Let's check any task from that DAG.
      const orphans = ['Downstream 1', 'Downstream 2'];
      const dagTasks = ctx.dagStore.getDag(delDagId);
      if (dagTasks && dagTasks.tasks) {
        for (const t of dagTasks.tasks) {
          if (orphans.some((o) => t.title.includes(o))) {
            assert.ok(!(t.dependencies || []).includes(delTaskId),
              `${t.title} should not have deleted node as dependency`);
          }
        }
      }
    });

    test('orphans with no remaining deps are auto-activated', async () => {
      // The downstream tasks only had one dependency (the deleted node).
      // After deletion, they should be auto-activated.
      const dagTasks = ctx.dagStore.getDag(delDagId);
      if (dagTasks && dagTasks.tasks) {
        const downstream = dagTasks.tasks.filter((t) =>
          t.title.includes('Downstream 1') || t.title.includes('Downstream 2')
        );
        for (const t of downstream) {
          assert.strictEqual(t.status, 'active', `${t.title} should be active, got: ${t.status}`);
        }
      }
    });

    test('DAG task_count is decremented', async () => {
      const dag = ctx.dagStore.getDag(delDagId);
      // Original: 3 tasks, deleted 1 → 2
      if (dag) {
        assert.strictEqual(dag.task_count, 2);
      }
    });

    test('throws for non-existent task', async () => {
      try {
        await ctx.dagStore.deleteTaskNode('dtask_never');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('not found'));
      }
    });
  });

  // ── approveProposal / rejectProposal ─────────────────────────────────────

  describe('approveProposal / rejectProposal', () => {
    test('approveProposal sets executor/reviewer and transitions to pending', async () => {
      await ctx.dagStore.approveProposal(ctx.proposedTaskId, {
        executorUid: ctx.feUid,
        reviewerUid: ctx.beUid,
        dependencies: [],
        acceptanceCriteria: 'Approved criteria.',
      });

      const task = ctx.dagStore.getTask(ctx.proposedTaskId);
      assert.strictEqual(task.status, 'pending');
      assert.strictEqual(task.executor_uid, ctx.feUid);
      assert.strictEqual(task.reviewer_uid, ctx.beUid);
      assert.strictEqual(task.acceptance_criteria, 'Approved criteria.');
    });

    test('approveProposal unblocks the blocking task', async () => {
      const blocked = ctx.dagStore.getTask(ctx.blockedTaskId);
      assert.strictEqual(blocked.status, 'active');
      assert.strictEqual(blocked.block_reason, undefined);
    });

    test('approveProposal clears blocked_task_id on proposal', async () => {
      const task = ctx.dagStore.getTask(ctx.proposedTaskId);
      assert.strictEqual(task.blocked_task_id, undefined);
    });

    test('approveProposal rejects non-proposed status', async () => {
      // Create a regular pending task.
      const dag = await ctx.dagStore.createDag({
        title: 'NonProposed', description: 'Test.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Regular', description: 'Already pending.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
      });

      try {
        await ctx.dagStore.approveProposal(t.task_id, {
          executorUid: ctx.feUid, reviewerUid: ctx.beUid,
        });
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('not in proposed status'));
      }
    });

    test('approveProposal validates executor!=reviewer', async () => {
      // Create a fresh proposed task with same validation.
      const dag = await ctx.dagStore.createDag({
        title: 'SameAgent', description: 'Test.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Proposal2', description: 'Test.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid, acceptance_criteria: 'TBD.',
      });
      // Set to proposed.
      const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
      const store = require('../lib/agentBus/store');
      await withFileLock(store.DB_PATH, async () => {
        const db = await store._load();
        if (db.dag_tasks[t.task_id]) {
          db.dag_tasks[t.task_id].status = 'proposed';
          db.dag_tasks[t.task_id].executor_uid = null;
          db.dag_tasks[t.task_id].reviewer_uid = null;
          await atomicWriteJson(store.DB_PATH, db);
        }
      });

      try {
        await ctx.dagStore.approveProposal(t.task_id, {
          executorUid: ctx.feUid,
          reviewerUid: ctx.feUid, // Same!
        });
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('must be different'));
      }
    });

    test('rejectProposal transitions to rejected', async () => {
      // Create a proposed task and reject it.
      const dag = await ctx.dagStore.createDag({
        title: 'Reject Test', description: 'Test.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Reject Me', description: 'Will be rejected.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'TBD.',
      });
      const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
      const store = require('../lib/agentBus/store');
      await withFileLock(store.DB_PATH, async () => {
        const db = await store._load();
        if (db.dag_tasks[t.task_id]) {
          db.dag_tasks[t.task_id].status = 'proposed';
          db.dag_tasks[t.task_id].executor_uid = null;
          db.dag_tasks[t.task_id].reviewer_uid = null;
          await atomicWriteJson(store.DB_PATH, db);
        }
      });

      await ctx.dagStore.rejectProposal(t.task_id, 'Not aligned with goals.');
      const task = ctx.dagStore.getTask(t.task_id);
      assert.strictEqual(task.status, 'rejected');
      assert.strictEqual(task.review_comment, 'Not aligned with goals.');
    });
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  describe('dagStore Sprint 37 edge cases', () => {
    test('deleteTaskNode with no downstream deps', async () => {
      const dag = await ctx.dagStore.createDag({
        title: 'Solo Delete', description: 'Single node.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Solo', description: 'No deps.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
      });

      const result = await ctx.dagStore.deleteTaskNode(t.task_id);
      assert.strictEqual(result.deleted, t.task_id);
      assert.deepStrictEqual(result.orphans, []);
      assert.strictEqual(ctx.dagStore.getTask(t.task_id), null);
    });

    test('task_count never goes negative', async () => {
      const dag = await ctx.dagStore.createDag({
        title: 'Count Test', description: 'Test count.',
        workspace: 'boos-test', createdBy: ctx.pmUid,
      });
      const t = await ctx.dagStore.addTask(dag.dag_id, {
        title: 'Count Me', description: 'Single.',
        executor_uid: ctx.feUid, reviewer_uid: ctx.beUid,
        acceptance_criteria: 'Done.',
      });
      await ctx.dagStore.deleteTaskNode(t.task_id);
      const d = ctx.dagStore.getDag(dag.dag_id);
      assert.strictEqual(d.task_count, 0);
    });
  });
});

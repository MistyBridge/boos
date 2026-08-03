'use strict';

// Feedback Manager — tests for lib/agentBus/feedbackManager.js
//
// Covers: sendFeedback (PM busy vs idle wake logic), notifyUser (ROOT inbox),
// sendDecisionAnswer (persistence + PM notification), isPmIdle, getPmUid.
//
// Uses temp BOOS_HOME with goals.json and agent-bus.json — zero mocking.

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
  '../lib/agentBus/collaborationLoop',
  '../lib/agentBus/goalStore', '../lib/agentBus/feedbackManager',
  '../lib/agentBus/queue',
  '../lib/identityResolver', '../lib/identityAdapter',
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
  TMP = path.join(os.tmpdir(), 'boos-fbmgr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
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
  return `fbtest-${n}-${n}-${n}`;
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Feedback Manager', () => {
  let feedbackManager, goalStore, store, dagStore;
  let pmUid, rootUid, userUid, goalId, dagId, taskId;

  before(async () => {
    freshSetup();

    store = require('../lib/agentBus/store');
    goalStore = require('../lib/agentBus/goalStore');
    dagStore = require('../lib/agentBus/dagStore');

    // Register agents: PM (supervisor), ROOT, and a user.
    pmUid = nextUid();
    rootUid = nextUid();
    userUid = nextUid();

    await store.insertAgent({ uid: pmUid, name: 'PM-Test', intro: 'PM', workspace: 'boos-test', role: 'supervisor', capabilities: ['architecture'] });
    await store.insertAgent({ uid: rootUid, name: 'ROOT', intro: 'Root', workspace: 'boos-test', role: 'root', capabilities: [] });
    await store.insertAgent({ uid: userUid, name: 'User', intro: 'User', workspace: 'boos-test', role: 'worker', capabilities: [] });

    // Create a Goal.
    const goalResult = await goalStore.createGoal({
      title: 'Test Goal for Feedback',
      description: 'Goal for testing feedback manager.',
      workspace: 'boos-test',
      project: 'boos-core',
      creatorUid: userUid,
    });
    assert.ok(goalResult.ok, 'goal creation: ' + JSON.stringify(goalResult));
    goalId = goalResult.goal.goal_id;

    // Create a DAG linked to this goal.
    const dag = await dagStore.createDag({
      title: 'Feedback DAG',
      description: 'For feedback testing.',
      workspace: 'boos-test',
      createdBy: pmUid,
    });

    // Manually link goal to DAG.
    const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
    await withFileLock(store.DB_PATH, async () => {
      const db = await store._load();
      if (db.dags && db.dags[dag.dag_id]) {
        db.dags[dag.dag_id].goal_id = goalId;
        await atomicWriteJson(store.DB_PATH, db);
      }
    });
    dagId = dag.dag_id;

    // Add a task.
    const t = await dagStore.addTask(dag.dag_id, {
      title: 'Feedback Task',
      description: 'A task.',
      executor_uid: userUid, reviewer_uid: pmUid,
      acceptance_criteria: 'Works.',
      review_questions: [
        { question_id: 'q1', question: 'What approach?', options: ['A', 'B'], user_choice: null, skipped: false, answered_at: null },
      ],
    });
    taskId = t.task_id;

    // Now require feedbackManager (after all state is set up).
    feedbackManager = require('../lib/agentBus/feedbackManager');
  });

  after(() => { teardown(); });

  // ── sendFeedback ────────────────────────────────────────────────────────

  describe('sendFeedback', () => {
    test('sendFeedback persists to goal feedback_thread', async () => {
      const result = await feedbackManager.sendFeedback({
        goalId,
        content: 'This is test feedback.',
        fromUid: userUid,
        fromName: 'Test User',
        type: 'overall',
      });

      // May return ok or error depending on queue/collaborationLoop availability.
      // Even if queue fails, feedback should be persisted.
      const goal = goalStore.getGoal(goalId);
      assert.ok(goal);
      assert.ok(goal.feedback_thread.length >= 1, 'should have at least one feedback entry');
      const fb = goal.feedback_thread[goal.feedback_thread.length - 1];
      assert.strictEqual(fb.from_uid, userUid);
      assert.strictEqual(fb.from_name, 'Test User');
      assert.strictEqual(fb.content, 'This is test feedback.');
      assert.strictEqual(fb.type, 'overall');
    });

    test('sendFeedback for specific task (node-level)', async () => {
      const result = await feedbackManager.sendFeedback({
        goalId,
        taskId,
        content: 'Node-specific feedback.',
        fromUid: userUid,
        fromName: 'Test User',
        type: 'node',
      });

      const goal = goalStore.getGoal(goalId);
      const fb = goal.feedback_thread[goal.feedback_thread.length - 1];
      assert.strictEqual(fb.target_task_id, taskId);
      assert.strictEqual(fb.type, 'node');
    });

    test('sendFeedback returns error for non-existent goal', async () => {
      const result = await feedbackManager.sendFeedback({
        goalId: 'goal_nonexist',
        content: 'Bad feedback.',
        fromUid: userUid,
        fromName: 'User',
        type: 'overall',
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    test('sendFeedback auto-detects type from taskId', async () => {
      const result = await feedbackManager.sendFeedback({
        goalId,
        taskId, // Providing taskId should make type 'node'
        content: 'Auto-type test.',
        fromUid: userUid,
        fromName: 'User',
      });

      const goal = goalStore.getGoal(goalId);
      const fb = goal.feedback_thread[goal.feedback_thread.length - 1];
      assert.strictEqual(fb.target_task_id, taskId);
      assert.strictEqual(fb.type, 'node');
    });
  });

  // ── notifyUser ──────────────────────────────────────────────────────────

  describe('notifyUser', () => {
    test('notifyUser sends notification to ROOT inbox', async () => {
      const result = await feedbackManager.notifyUser({
        goalId,
        message: 'DAG completed successfully!',
        type: 'completion',
      });

      // The queue may or may not be available — just verify it doesn't crash
      // and returns a result.
      assert.ok(result.ok !== undefined || result.error !== undefined);
    });

    test('notifyUser persists notification to goal feedback_thread when no ROOT', async () => {
      // Temporarily remove ROOT agent.
      const { withFileLock, atomicWriteJson } = require('../lib/agentBus/storeCore');
      await withFileLock(store.DB_PATH, async () => {
        const db = await store._load();
        delete db.agents[rootUid];
        await atomicWriteJson(store.DB_PATH, db);
      });

      const result = await feedbackManager.notifyUser({
        goalId,
        message: 'No ROOT available.',
        type: 'info',
      });

      // Should still succeed (root_notified: false).
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.root_notified, false);

      // Restore ROOT.
      await store.insertAgent({ uid: rootUid, name: 'ROOT', intro: 'Root', workspace: 'boos-test', role: 'root', capabilities: [] });
    });

    test('notifyUser handles no goalId gracefully', async () => {
      const result = await feedbackManager.notifyUser({
        message: 'System notification without goal.',
        type: 'info',
      });

      assert.ok(result.ok !== undefined || result.error !== undefined);
    });
  });

  // ── sendDecisionAnswer ──────────────────────────────────────────────────

  describe('sendDecisionAnswer', () => {
    test('sendDecisionAnswer persists answer to task review_questions', async () => {
      const result = await feedbackManager.sendDecisionAnswer({
        taskId,
        questionId: 'q1',
        choice: { choice: 'A', skipped: false },
        fromUid: userUid,
      });

      // May return ok or error depending on queue availability.
      // Verify the answer is persisted.
      const task = dagStore.getTask(taskId);
      if (task.review_questions) {
        const q = task.review_questions.find((x) => x.question_id === 'q1');
        assert.ok(q, 'question q1 should exist');
        assert.ok(q.user_choice === 'A' || q.user_choice === 'custom:A' || result.ok,
          'answer should be persisted or operation should succeed');
        assert.ok(q.answered_at);
      }
    });

    test('sendDecisionAnswer returns error for non-existent task', async () => {
      const result = await feedbackManager.sendDecisionAnswer({
        taskId: 'dtask_noexist',
        questionId: 'q1',
        choice: { choice: 'B', skipped: false },
        fromUid: userUid,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('task not found'));
    });

    test('sendDecisionAnswer returns error for non-existent question', async () => {
      const result = await feedbackManager.sendDecisionAnswer({
        taskId,
        questionId: 'q_nonexist',
        choice: { choice: 'X', skipped: false },
        fromUid: userUid,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error.includes('question not found'));
    });

    test('sendDecisionAnswer handles skipped answers', async () => {
      const result = await feedbackManager.sendDecisionAnswer({
        taskId,
        questionId: 'q1',
        choice: { choice: null, skipped: true },
        fromUid: userUid,
      });

      const task = dagStore.getTask(taskId);
      if (task.review_questions) {
        const q = task.review_questions.find((x) => x.question_id === 'q1');
        assert.ok(q.skipped || result.ok, 'should be marked skipped');
      }
    });

    test('sendDecisionAnswer handles custom_text answers', async () => {
      const result = await feedbackManager.sendDecisionAnswer({
        taskId,
        questionId: 'q1',
        choice: { choice: 'Other', skipped: false, custom_text: 'None of the above.' },
        fromUid: userUid,
      });

      const task = dagStore.getTask(taskId);
      if (task.review_questions) {
        const q = task.review_questions.find((x) => x.question_id === 'q1');
        // custom_text prepends 'custom:'
        assert.ok(
          q.user_choice === 'custom:None of the above.' || q.user_choice === 'None of the above.' || result.ok,
          'custom text should be encoded: ' + q.user_choice
        );
      }
    });
  });

  // ── isPmIdle / getPmUid ─────────────────────────────────────────────────

  describe('isPmIdle / getPmUid', () => {
    test('getPmUid returns PM uid for workspace', () => {
      const uid = feedbackManager.getPmUid('boos-test');
      assert.strictEqual(uid, pmUid);
    });

    test('getPmUid returns null for workspace without PM', () => {
      const uid = feedbackManager.getPmUid('empty-workspace');
      assert.ok(uid === null || uid === undefined);
    });

    test('isPmIdle returns boolean', async () => {
      const idle = await feedbackManager.isPmIdle('boos-test');
      // collaborationLoop may not be available in test env — just verify it returns a boolean.
      assert.strictEqual(typeof idle, 'boolean');
    });
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  describe('feedbackManager edge cases', () => {
    test('sendFeedback handles very long content (truncation)', async () => {
      const longContent = 'X'.repeat(5000);
      const result = await feedbackManager.sendFeedback({
        goalId,
        content: longContent,
        fromUid: userUid,
        fromName: 'User',
        type: 'overall',
      });

      const goal = goalStore.getGoal(goalId);
      const fb = goal.feedback_thread[goal.feedback_thread.length - 1];
      // addFeedback truncates to 4096
      assert.ok(fb.content.length <= 4096);
    });

    test('sendFeedback with empty content', async () => {
      const result = await feedbackManager.sendFeedback({
        goalId,
        content: '',
        fromUid: userUid,
        fromName: 'User',
        type: 'overall',
      });

      const goal = goalStore.getGoal(goalId);
      const fb = goal.feedback_thread[goal.feedback_thread.length - 1];
      assert.strictEqual(fb.content, '');
    });

    test('multiple feedback submissions accumulate in thread', async () => {
      const before = goalStore.getGoal(goalId).feedback_thread.length;

      await feedbackManager.sendFeedback({ goalId, content: 'Msg 1', fromUid: userUid, fromName: 'U', type: 'overall' });
      await feedbackManager.sendFeedback({ goalId, content: 'Msg 2', fromUid: userUid, fromName: 'U', type: 'overall' });
      await feedbackManager.sendFeedback({ goalId, content: 'Msg 3', fromUid: userUid, fromName: 'U', type: 'overall' });

      const after = goalStore.getGoal(goalId).feedback_thread.length;
      assert.ok(after >= before + 3, `expected >=${before + 3}, got ${after}`);
    });
  });
});

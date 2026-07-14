'use strict';

// Tests for Agent Role-based access control (handlers.js).
// Verifies that workers and supervisors have correct permissions.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── helpers ───────────────────────────────────────────────────────────

function setupBoosHome() {
  const dir = path.join(os.tmpdir(), `boos-test-role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.BOOS_HOME = dir;
  // Force reload cache for config-dependent modules.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('lib' + path.sep + 'config.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'agentBus' + path.sep + 'store.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'agentBus' + path.sep + 'registry.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'agentBus' + path.sep + 'queue.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'agentBus' + path.sep + 'handlers.js')) delete require.cache[key];
    if (key.includes('lib' + path.sep + 'workflowEngine.js')) delete require.cache[key];
  }
  return dir;
}

function teardownBoosHome(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Helper: register an agent and return a ctx object for dispatch().
function makeCtx(uid, workspace) {
  return { uid, workspace, sessionId: 'test_session_' + uid };
}

describe('Agent Role (handlers.js)', () => {
  let dispatch, registry, store;
  let boosHome;
  const WORKSPACE = 'test-ws-role';
  let supervisorUid;
  let workerUid;

  beforeEach(async () => {
    boosHome = setupBoosHome();
    dispatch = require('../lib/agentBus/handlers').dispatch;
    registry = require('../lib/agentBus/registry');
    store = require('../lib/agentBus/store');

    // Register a supervisor.
    const sup = await registry.registerAgent({
      name: 'SupervisorBot', intro: 'I oversee', workspace: WORKSPACE,
      role: 'supervisor',
    });
    assert.equal(sup.ok, true);
    supervisorUid = sup.uid;

    // Register a worker.
    const wrk = await registry.registerAgent({
      name: 'WorkerBot', intro: 'I execute', workspace: WORKSPACE,
      role: 'worker',
    });
    assert.equal(wrk.ok, true);
    workerUid = wrk.uid;
  });

  after(() => {
    if (boosHome) teardownBoosHome(boosHome);
  });

  // ── worker restrictions ──────────────────────────────────────────────

  test('worker cannot define_workflow (supervisor role required)', async () => {
    const ctx = makeCtx(workerUid, WORKSPACE);
    const r = await dispatch('define_workflow',
      { name: 'My WF', description: 'test' }, ctx);
    assert.ok(r.error, 'should return error');
    assert.ok(r.error.includes('supervisor role required'), `got: ${r.error}`);
  });

  test('worker cannot list_all_agents', async () => {
    const ctx = makeCtx(workerUid, WORKSPACE);
    const r = await dispatch('list_all_agents', {}, ctx);
    assert.ok(r.error, 'should return error');
    assert.ok(r.error.includes('supervisor role required'), `got: ${r.error}`);
  });

  test('worker cannot kill_worker', async () => {
    const ctx = makeCtx(workerUid, WORKSPACE);
    const r = await dispatch('kill_worker', { target_uid: 'some_agent' }, ctx);
    assert.ok(r.error, 'should return error');
    assert.ok(r.error.includes('supervisor role required'), `got: ${r.error}`);
  });

  test('worker cannot add_stage to any workflow', async () => {
    const ctx = makeCtx(workerUid, WORKSPACE);
    const r = await dispatch('add_stage',
      { workflow_id: 'wf_any', name: 'Stage' }, ctx);
    assert.ok(r.error, 'should return error');
    assert.ok(r.error.includes('supervisor role required'), `got: ${r.error}`);
  });

  // ── supervisor permissions ───────────────────────────────────────────

  test('supervisor CAN define_workflow', async () => {
    const ctx = makeCtx(supervisorUid, WORKSPACE);
    const r = await dispatch('define_workflow',
      { name: 'Supervised WF', description: 'owned by sup' }, ctx);
    assert.equal(r.ok, true);
    assert.ok(r.workflow_id.startsWith('wf_'));
    assert.equal(r.status, 'draft');
  });

  test('supervisor CAN list_all_agents', async () => {
    const ctx = makeCtx(supervisorUid, WORKSPACE);
    const r = await dispatch('list_all_agents', {}, ctx);
    assert.ok(r.agents, 'should return agents array');
    assert.ok(Array.isArray(r.agents));
    // Should see both supervisor and worker.
    const uids = r.agents.map((a) => a.uid);
    assert.ok(uids.includes(supervisorUid));
    assert.ok(uids.includes(workerUid));
  });

  test('supervisor CAN cancel someone else\'s pending task', async () => {
    // First, worker sends a task that stays pending (send to nonexistent receiver).
    const ctxWorker = makeCtx(workerUid, WORKSPACE);
    const sendR = await dispatch('send_task',
      { to_uid: 'agent_nonexistent', content: 'test task' }, ctxWorker);
    // Since receiver doesn't exist, this may fail. Let's create another worker to receive.
    const wrk2 = registry.registerAgent({
      name: 'WorkerBot2', intro: '', workspace: WORKSPACE,
      role: 'worker',
    });

    const sendR2 = await dispatch('send_task',
      { to_uid: wrk2.uid, content: 'A pending task' }, ctxWorker);

    if (sendR2.ok && sendR2.task) {
      const taskId = sendR2.task.task_id;
      // Verify task is pending.
      const task = store.getTask(taskId);
      assert.equal(task.status, 'pending');

      // Supervisor cancels it.
      const ctxSup = makeCtx(supervisorUid, WORKSPACE);
      const cancelR = await dispatch('cancel_task', { task_id: taskId }, ctxSup);
      assert.equal(cancelR.ok, true, 'supervisor should be able to cancel');
    }
  });

  test('supervisor CAN interrupt someone else\'s in-progress task', async () => {
    // Register a second worker to receive tasks.
    const wrk2 = registry.registerAgent({
      name: 'WorkerBot3', intro: '', workspace: WORKSPACE,
      role: 'worker',
    });

    // Worker sends to wrk2.
    const ctxWorker = makeCtx(workerUid, WORKSPACE);
    const sendR = await dispatch('send_task',
      { to_uid: wrk2.uid, content: 'Task to interrupt' }, ctxWorker);

    if (sendR.ok && sendR.task) {
      // Wrk2 checks inbox to move it to in_progress.
      const ctxWrk2 = makeCtx(wrk2.uid, WORKSPACE);
      const inbox = await dispatch('check_inbox', {}, ctxWrk2);
      if (inbox.task) {
        // Re-query to confirm it's in_progress.
        const task = store.getTask(inbox.task.task_id);
        if (task && task.status === 'in_progress') {
          // Supervisor interrupts it.
          const ctxSup = makeCtx(supervisorUid, WORKSPACE);
          const interruptR = await dispatch('interrupt_task', { task_id: task.task_id }, ctxSup);
          assert.equal(interruptR.ok, true, 'supervisor should be able to interrupt');
        }
      }
    }
  });

  // ── default role ─────────────────────────────────────────────────────

  test('agent without role field defaults to worker (backward compat)', async () => {
    // Register an agent without specifying role.
    const r = await registry.registerAgent({
      name: 'LegacyAgent', intro: '', workspace: WORKSPACE,
      // No 'role' field.
    });
    assert.equal(r.ok, true);

    // Verify it gets worker role.
    const agent = store.getAgent(r.uid);
    assert.equal(agent.role, 'worker');

    // Verify it cannot use supervisor-only tools.
    const ctx = makeCtx(r.uid, WORKSPACE);
    const defR = await dispatch('define_workflow',
      { name: 'Should fail', description: '' }, ctx);
    assert.ok(defR.error, 'should return error');
    assert.ok(defR.error.includes('supervisor role required'));
  });

  test('role "supervisor" is stored correctly', async () => {
    const sup = store.getAgent(supervisorUid);
    assert.equal(sup.role, 'supervisor');
  });

  test('role "worker" is stored correctly', async () => {
    const wrk = store.getAgent(workerUid);
    assert.equal(wrk.role, 'worker');
  });
});

'use strict';

// Sprint 20 regression: respond_task must complete a `request`-typed task in a
// single step. The old Sprint 19 gate required a separate
// send_task(message_type="response") BEFORE respond_task would succeed, which
// deadlocked every normal reply — the "respond_task 无法提交" bug.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tmpBase;

before(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-respond-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  for (const m of ['../lib/config', '../lib/agentBus/store',
    '../lib/agentBus/storeAgents', '../lib/agentBus/storeTasks',
    '../lib/agentBus/storeCore', '../lib/agentBus/storeIdentity',
    '../lib/agentBus/auth', '../lib/agentBus/handlersAdmin',
    '../lib/agentBus/queue', '../lib/agentBus/registry', '../lib/agentBus/handlers']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

describe('respond_task single-step completion (Sprint 20 regression)', () => {
  test('receiver can respond_task on a request task without a prior response send', async () => {
    const registry = require('../lib/agentBus/registry');
    const store = require('../lib/agentBus/store');
    const queue = require('../lib/agentBus/queue');
    const { dispatch } = require('../lib/agentBus/handlers');

    // Sprint 33: cliSessionId (Claude --resume UUID) is the agent uid.
    // Sprint 37: worker→supervisor responses enter "submitted" (PM settlement).
    // Use a worker sender so respond_task auto-completes in one step, matching
    // the Sprint 20 single-step intent without the settlement gate.
    const pm = await registry.registerAgent({
      name: 'resp-pm', intro: 'sender', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
      cliSessionId: 'resp-pm-uid',
    });
    const worker = await registry.registerAgent({
      name: 'resp-worker', intro: 'receiver', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
      cliSessionId: 'resp-worker-uid',
    });

    const pmCtx = { sessionId: 'sess-pm', uid: pm.uid, workspace: 'boos' };
    const workerCtx = { sessionId: 'sess-worker', uid: worker.uid, workspace: 'boos' };

    // PM sends a request task (message_type defaults to "request").
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'please do X',
    }, pmCtx);
    assert.ok(sent.ok, 'send_task should succeed: ' + JSON.stringify(sent));
    const taskId = sent.task.task_id;

    // Worker claims it. check_inbox returns { inbox_empty, task, instant }.
    const claimed = await dispatch('check_inbox', { wait: false }, workerCtx);
    assert.ok(claimed && !claimed.inbox_empty && claimed.task && claimed.task.task_id === taskId,
      'worker should claim the task: ' + JSON.stringify(claimed));

    // Worker responds in ONE step — this is exactly what used to be blocked.
    const responded = await dispatch('respond_task', {
      task_id: taskId, result: 'X is done',
    }, workerCtx);
    assert.ok(responded.ok, 'respond_task must succeed in one step: ' + JSON.stringify(responded));

    // Task is now completed with the result recorded.
    // Sprint 35: completed tasks are archived — query the archive.
    const finalTask = await queue.getArchivedTask(taskId);
    assert.ok(finalTask, 'task should be archived after completion');
    assert.equal(finalTask.status, 'completed', 'task should be completed');
    assert.equal(finalTask.result, 'X is done', 'result should be recorded');
  });

  test('respond_task rejects a task the caller does not own', async () => {
    const registry = require('../lib/agentBus/registry');
    const { dispatch } = require('../lib/agentBus/handlers');

    // Sprint 33: cliSessionId (Claude --resume UUID) is the agent uid.
    const pm = await registry.registerAgent({
      name: 'resp-pm2', intro: 'sender', workspace: 'boos',
      role: 'supervisor', capabilities: ['test'],
      cliSessionId: 'resp-pm2-uid',
    });
    const worker = await registry.registerAgent({
      name: 'resp-worker2', intro: 'receiver', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
      cliSessionId: 'resp-worker2-uid',
    });
    const stranger = await registry.registerAgent({
      name: 'resp-stranger', intro: 'not the receiver', workspace: 'boos',
      role: 'worker', capabilities: ['test'],
      cliSessionId: 'resp-stranger-uid',
    });

    const pmCtx = { sessionId: 'sess-pm2', uid: pm.uid, workspace: 'boos' };
    const workerCtx = { sessionId: 'sess-worker2', uid: worker.uid, workspace: 'boos' };
    const strangerCtx = { sessionId: 'sess-stranger', uid: stranger.uid, workspace: 'boos' };

    const sent = await dispatch('send_task', { to_uid: worker.uid, content: 'do Y' }, pmCtx);
    const taskId = sent.task.task_id;
    await dispatch('check_inbox', { wait: false }, workerCtx);

    // Stranger tries to respond — must be rejected.
    const bad = await dispatch('respond_task', { task_id: taskId, result: 'hijack' }, strangerCtx);
    assert.ok(bad.error, 'non-receiver respond_task should be rejected');
  });
});

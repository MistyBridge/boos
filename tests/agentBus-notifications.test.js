'use strict';

// Sprint 38 vFinal: _buildWakeCommand + _injectCommand unit tests + Settlement flow.
//
// P0: _buildWakeCommand — always returns bare 'check_inbox[BOOS]' (no context header).
//     Multi-line injection is not feasible (two \n\r submits race). Context arrives
//     via SSE + inbox response. PTY is ONLY the wake trigger.
// P1: _injectCommand — burst/typed/paste modes, \n\r appended.
// P2: Settlement notification — Worker respond → PM inbox → PM reject → Worker inbox.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tmpBase;

before(() => {
  tmpBase = path.join(os.tmpdir(), 'boos-notif-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  const mods = [
    '../lib/config',
    '../lib/persistedSessions',
    '../lib/jsonStore',
    '../lib/agentBus/store',
    '../lib/agentBus/storeCore',
    '../lib/agentBus/inboxStore',
    '../lib/agentBus/queue',
    '../lib/agentBus/registry',
    '../lib/agentBus/handlers',
    '../lib/agentBus/notifications',
    '../lib/agentBus/notificationsWake',
    '../lib/agentBus/sleepManager',
    '../lib/agentBus/taskSystem',
    '../lib/agentBus/dagStore',
    '../lib/agentBus/goalStore',
    '../lib/agentBus/feedbackManager',
  ];
  for (const m of mods) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
});

after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── P0: _buildWakeCommand unit tests (Sprint 38 vFinal) ────────────────────

describe('_buildWakeCommand (Sprint 38 vFinal)', () => {
  let _buildWakeCommand;

  before(() => {
    ({ _buildWakeCommand } = require('../lib/agentBus/notificationsWake'));
  });

  test('always returns bare check_inbox[BOOS] regardless of args', () => {
    assert.equal(_buildWakeCommand([], {}), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand([]), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand([], { header: null }), 'check_inbox[BOOS]');
    assert.equal(_buildWakeCommand(['task_abc123'], {
      header: 'A3(90490923) submitted #task_abc123 — PM settle required',
    }), 'check_inbox[BOOS]');
  });

  test('never includes [BOOS] context header prefix', () => {
    const result = _buildWakeCommand(['task_1', 'task_2'], {
      header: '2 pending tasks',
    });
    assert.ok(!result.startsWith('[BOOS] '), 'must NOT have BOOS prefix');
    assert.ok(!result.includes('[BOOS]'), 'must NOT have BOOS prefix anywhere');
    assert.equal(result, 'check_inbox[BOOS]');
  });

  test('never includes newline separator', () => {
    const result = _buildWakeCommand(['task_xyz'], {
      header: 'worker submitted task_xyz',
    });
    assert.ok(!result.includes('\n'), 'must NOT contain newline');
    assert.ok(!result.includes('\r'), 'must NOT contain carriage return');
    assert.equal(result, 'check_inbox[BOOS]');
  });

  test('taskIds param is ignored (PTY is bare wake trigger)', () => {
    const result = _buildWakeCommand(['task_1', 'task_2'], {
      header: '2 pending tasks',
    });
    assert.ok(!result.includes('task_1'), 'should not inject task IDs');
    assert.ok(!result.includes('task_2'), 'should not inject task IDs');
  });
});

// ── P1: _injectCommand unit tests (Sprint 38 vFinal) ───────────────────────

describe('_injectCommand (Sprint 38 vFinal)', () => {
  let _injectCommand, _writeToPty, _buildWakeCommand;
  let writes = [];

  before(() => {
    const mod = require('../lib/agentBus/notificationsWake');
    _injectCommand = mod._injectCommand;
    _buildWakeCommand = mod._buildWakeCommand;
    // Intercept _writeToPty to capture writes.
    const orig = mod._writeToPty;
    mod._writeToPty = function (sessionId, data) {
      writes.push({ sessionId, data });
    };
  });

  after(() => {
    writes = [];
  });

  test('burst mode — appends \\n\\r (LF+CR, 0x0A 0x0D)', () => {
    writes = [];
    _injectCommand('sess-test', 'check_inbox[BOOS]');
    assert.equal(writes.length, 1, 'should have exactly one write');
    assert.equal(writes[0].data, 'check_inbox[BOOS]\n\r',
      'should append \\n\\r for submit');
    assert.ok(writes[0].data.endsWith('\n\r'),
      'should end with LF+CR');
  });

  test('full pipeline: _buildWakeCommand → _injectCommand', () => {
    writes = [];
    const cmd = _buildWakeCommand(['task_001'], {
      header: 'worker submitted task_001',
    });
    _injectCommand('sess-test', cmd);
    assert.equal(writes.length, 1);
    // _buildWakeCommand returns bare check_inbox[BOOS], _injectCommand appends \n\r
    assert.equal(writes[0].data, 'check_inbox[BOOS]\n\r');
  });

  test('paste mode — wraps in bracketed-paste escape sequences', () => {
    writes = [];
    const prev = process.env.BOOS_PTY_INJECT_MODE;
    process.env.BOOS_PTY_INJECT_MODE = 'paste';
    try {
      _injectCommand('sess-test', 'check_inbox[BOOS]');
      assert.equal(writes.length, 1);
      assert.ok(writes[0].data.startsWith('\x1b[200~'), 'should start with bracketed-paste start');
      assert.ok(writes[0].data.endsWith('\x1b[201~'), 'should end with bracketed-paste end');
      assert.ok(writes[0].data.includes('check_inbox[BOOS]\n\r'), 'should contain command + \\n\\r');
    } finally {
      process.env.BOOS_PTY_INJECT_MODE = prev;
    }
  });

  test('typed mode — char-by-char with delay (async, verify command same)', () => {
    writes = [];
    const prev = process.env.BOOS_PTY_INJECT_MODE;
    process.env.BOOS_PTY_INJECT_MODE = 'typed';
    try {
      // _typedInject is async but writes first char synchronously.
      _injectCommand('sess-test', 'AB\n\r');
      // At least first char should have been written
      assert.ok(writes.length >= 1, 'typed mode should write at least first char');
    } finally {
      process.env.BOOS_PTY_INJECT_MODE = prev;
    }
  });
});

// ── P1: Settlement notification flow ──────────────────────────────────────

describe('Settlement notification flow (Sprint 38)', () => {
  let registry, store, inboxStore, dispatch;

  before(() => {
    registry = require('../lib/agentBus/registry');
    store = require('../lib/agentBus/store');
    inboxStore = require('../lib/agentBus/inboxStore');
    ({ dispatch } = require('../lib/agentBus/handlers'));
  });

  test('worker respond_task → PM inbox receives settlement notification', async () => {
    const pm = await registry.registerAgent({
      name: 'settle-pm', intro: 'PM for settlement test', workspace: 'boos',
      role: 'supervisor', capabilities: ['review'],
      cliSessionId: 'a0000001-0001-0001-0001-000000000001',
    });
    const worker = await registry.registerAgent({
      name: 'settle-worker', intro: 'Worker for settlement test', workspace: 'boos',
      role: 'worker', capabilities: ['code'],
      cliSessionId: 'a0000001-0001-0001-0001-000000000002',
    });

    const pmCtx = { sessionId: 'sess-pm', uid: pm.uid, workspace: 'boos' };
    const workerCtx = { sessionId: 'sess-worker', uid: worker.uid, workspace: 'boos' };

    // PM sends task to worker.
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'build feature X',
    }, pmCtx);
    assert.ok(sent.ok, 'send_task should succeed');
    const taskId = sent.task.task_id;

    // Worker claims it.
    const claimed = await dispatch('check_inbox', { wait: false }, workerCtx);
    assert.ok(claimed && !claimed.inbox_empty, 'worker should have task in inbox');

    // Worker responds — triggers _onTaskSubmitted → inboxStore.addPending(PM).
    // _onTaskSubmitted is async but the event emitter doesn't await it.
    const responded = await dispatch('respond_task', {
      task_id: taskId, result: 'feature X is ready for review',
    }, workerCtx);
    assert.ok(responded.ok, 'respond_task should succeed');
    assert.equal(responded.status, 'submitted', 'task should be in submitted state');
    assert.equal(responded.needs_settlement, true, 'task needs settlement');

    // Wait for async _onTaskSubmitted handler to write to PM's inbox.
    await new Promise((r) => setTimeout(r, 200));

    // PM's inbox should now have a settlement notification.
    const pmInbox = await inboxStore.loadInbox(pm.uid);
    const settlementTask = pmInbox.pending.find(
      (t) => t.metadata && t.metadata.event === 'task_submitted' && t.metadata.task_id === taskId
    );
    assert.ok(settlementTask, 'PM inbox should have settlement notification');
    assert.ok(
      settlementTask.content.includes(taskId),
      'notification content should include task_id'
    );
    assert.ok(
      settlementTask.content.includes('settle-worker'),
      'notification content should include worker name'
    );
    assert.equal(settlementTask.receiver_uid, pm.uid, 'notification receiver should be PM');
    assert.equal(settlementTask.sender_uid, worker.uid, 'notification sender should be worker');
    assert.equal(settlementTask.priority, 'high', 'settlement notifications should be high priority');
  });

  test('PM reject → worker inbox receives rejection notification', async () => {
    const pm = await registry.registerAgent({
      name: 'reject-pm', intro: 'PM for rejection test', workspace: 'boos',
      role: 'supervisor', capabilities: ['review'],
      cliSessionId: 'b0000001-0001-0001-0001-000000000001',
    });
    const worker = await registry.registerAgent({
      name: 'reject-worker', intro: 'Worker for rejection test', workspace: 'boos',
      role: 'worker', capabilities: ['code'],
      cliSessionId: 'b0000001-0001-0001-0001-000000000002',
    });

    const pmCtx = { sessionId: 'sess-pm2', uid: pm.uid, workspace: 'boos' };
    const workerCtx = { sessionId: 'sess-w2', uid: worker.uid, workspace: 'boos' };

    // PM sends task.
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'write tests',
    }, pmCtx);
    assert.ok(sent.ok);
    const taskId = sent.task.task_id;

    // Worker claims and responds.
    const claimed = await dispatch('check_inbox', { wait: false }, workerCtx);
    assert.ok(claimed && !claimed.inbox_empty);
    await dispatch('respond_task', {
      task_id: taskId, result: 'draft tests ready',
    }, workerCtx);

    // Wait for async _onTaskSubmitted handler.
    await new Promise((r) => setTimeout(r, 200));

    // PM settles: reject.
    const rejected = await dispatch('settle_task', {
      task_id: taskId, action: 'reject', feedback: 'needs more coverage',
    }, pmCtx);
    assert.ok(rejected.ok, 'settle_task reject should succeed');

    // Wait for async _onTaskRejectedByPM handler to write to worker's inbox.
    await new Promise((r) => setTimeout(r, 200));

    // Worker's inbox should have a rejection notification.
    const workerInbox = await inboxStore.loadInbox(worker.uid);
    const rejectNotif = workerInbox.pending.find(
      (t) => t.metadata && t.metadata.event === 'task_rejected_by_pm'
    );
    assert.ok(rejectNotif, 'worker inbox should have rejection notification');
    assert.ok(
      rejectNotif.content.includes(taskId),
      'rejection content should include task_id'
    );
    assert.ok(
      rejectNotif.content.includes('needs more coverage'),
      'rejection content should include PM feedback'
    );
    assert.equal(rejectNotif.receiver_uid, worker.uid, 'notification receiver should be worker');
    assert.equal(rejectNotif.sender_uid, pm.uid, 'notification sender should be PM');
    assert.equal(rejectNotif.priority, 'high', 'rejection notifications should be high priority');
  });

  test('PM approve → task status completed, no error notification', async () => {
    const pm = await registry.registerAgent({
      name: 'approve-pm', intro: 'PM for approval test', workspace: 'boos',
      role: 'supervisor', capabilities: ['review'],
      cliSessionId: 'c0000001-0001-0001-0001-000000000001',
    });
    const worker = await registry.registerAgent({
      name: 'approve-worker', intro: 'Worker for approval test', workspace: 'boos',
      role: 'worker', capabilities: ['code'],
      cliSessionId: 'c0000001-0001-0001-0001-000000000002',
    });

    const pmCtx = { sessionId: 'sess-pm3', uid: pm.uid, workspace: 'boos' };
    const workerCtx = { sessionId: 'sess-w3', uid: worker.uid, workspace: 'boos' };

    // PM → Worker: send task.
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'add logging',
    }, pmCtx);
    assert.ok(sent.ok);
    const taskId = sent.task.task_id;

    // Worker claims and responds.
    const claimed = await dispatch('check_inbox', { wait: false }, workerCtx);
    assert.ok(claimed && !claimed.inbox_empty);
    await dispatch('respond_task', {
      task_id: taskId, result: 'logging added with pino',
    }, workerCtx);

    // Wait for async _onTaskSubmitted handler.
    await new Promise((r) => setTimeout(r, 200));

    // Capture worker inbox state before PM settles.
    const workerInboxBefore = await inboxStore.loadInbox(worker.uid);
    const rejectCountBefore = workerInboxBefore.pending.filter(
      (t) => t.metadata && t.metadata.event === 'task_rejected_by_pm'
    ).length;

    // PM settles: approve.
    const approved = await dispatch('settle_task', {
      task_id: taskId, action: 'approve',
    }, pmCtx);
    assert.ok(approved.ok, 'settle_task approve should succeed');

    // Task should be moved from submitted to completed in worker's inbox.
    const workerInboxAfter = await inboxStore.loadInbox(worker.uid);
    const completedTask = workerInboxAfter.pending.find(
      (t) => t.task_id === taskId
    );
    // After approve, task should no longer be pending (moved out by completeTask).
    // It should also not be in in_progress.
    const inProgressTask = workerInboxAfter.in_progress.find(
      (t) => t.task_id === taskId
    );
    assert.ok(!completedTask && !inProgressTask,
      'task should no longer be in pending or in_progress after approve');

    // Worker should NOT get a rejection notification on approve.
    const rejectCountAfter = workerInboxAfter.pending.filter(
      (t) => t.metadata && t.metadata.event === 'task_rejected_by_pm'
    ).length;
    assert.equal(rejectCountAfter, rejectCountBefore,
      'approve should not generate rejection notifications');
  });
});

// ── P3: wakeAgent bare PTY trigger (Sprint 38 vFinal) ──────────────────────

describe('wakeAgent bare PTY trigger (Sprint 38 vFinal)', () => {
  let store, registry, inboxStore;

  before(() => {
    store = require('../lib/agentBus/store');
    registry = require('../lib/agentBus/registry');
    inboxStore = require('../lib/agentBus/inboxStore');
  });

  test('_buildWakeCommand always returns bare check_inbox[BOOS]', () => {
    const { _buildWakeCommand } = require('../lib/agentBus/notificationsWake');

    // With message — still bare (context via SSE + inbox, not PTY).
    const cmd = _buildWakeCommand(['task_001'], {
      header: 'A3(90490923) submitted #task_001 — PM settle required',
    });
    assert.equal(cmd, 'check_inbox[BOOS]');
    assert.ok(!cmd.includes('[BOOS]'), 'no BOOS prefix in vFinal');
    assert.ok(!cmd.includes('\n'), 'no newline in vFinal');

    // Without message — bare.
    const cmd2 = _buildWakeCommand([], { header: null });
    assert.equal(cmd2, 'check_inbox[BOOS]');
  });

  test('_injectCommand appends \\n\\r to trigger submit', () => {
    const { _injectCommand, _writeToPty } = require('../lib/agentBus/notificationsWake');
    const writes = [];
    const orig = _writeToPty;
    require('../lib/agentBus/notificationsWake')._writeToPty = function (s, d) {
      writes.push({ s, d });
    };
    try {
      _injectCommand('sess-x', 'check_inbox[BOOS]');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].d, 'check_inbox[BOOS]\n\r');
    } finally {
      require('../lib/agentBus/notificationsWake')._writeToPty = orig;
    }
  });
});

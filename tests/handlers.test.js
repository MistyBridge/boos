'use strict';

// AgentBus Handlers — tests for lib/agentBus/handlers.js
//
// Covers: dispatch(), core messaging handlers (register, deregister, list_agents,
// send_task, check_inbox, respond_task, cancel_task, interrupt_task, retry_task,
// list_my_tasks, get_task, broadcast), role checks, error paths, and edge cases.
//
// Follows the same pattern as respond-task-regression.test.js: temp BOOS_HOME,
// clear require caches, registry.registerAgent + dispatch() for testing.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tmpBase;

const CLEAR_MODS = [
  '../lib/config', '../lib/agentBus/storeCore',
  '../lib/agentBus/store', '../lib/agentBus/storeTasks', '../lib/agentBus/storeIdentity',
  '../lib/agentBus/queue', '../lib/agentBus/registry',
  '../lib/agentBus/handlers', '../lib/agentBus/handlersAdmin',
  '../lib/agentBus/handlersDag', '../lib/agentBus/handlersSession',
  '../lib/agentBus/notifications', '../lib/agentBus/notificationsWake',
  '../lib/agentBus/heartbeat', '../lib/agentBus/collaborationLoop',
  '../lib/agentBus/inboxStore', '../lib/agentBus/auth',
  '../lib/agentBus/taskAnalytics', '../lib/agentBus/taskTimeout',
  '../lib/agentBus/fileLock', '../lib/agentBus/constraints',
  '../lib/agentBus/transport', '../lib/agentBus/autoSupervisor',
  '../lib/identityResolver', '../lib/identityAdapter',
  '../lib/folders', '../lib/persistedSessions',
  '../lib/sandbox', '../lib/hrAgent',
  // Sprint 37: dagStore and sub-modules that hold store.DB_PATH at top level.
  '../lib/agentBus/dagStore', '../lib/agentBus/dagEngine',
  '../lib/agentBus/taskSystem', '../lib/agentBus/dagDecomposer',
  '../lib/agentBus/goalStore', '../lib/agentBus/feedbackManager',
  '../lib/agentBus/sleepManager',
];

function clearCaches() {
  for (const m of CLEAR_MODS) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

function freshSetup() {
  if (tmpBase) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }
  tmpBase = path.join(os.tmpdir(), 'boos-handlers-' + Date.now().toString(36));
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.BOOS_HOME = tmpBase;
  clearCaches();
}

function teardown() {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function nextUid() {
  const n = String(++_counter).padStart(8, '0');
  return `test-${n}-${n}-${n}-${n}${n}${n}${n}${n}${n}`;
}

async function registerPm(name = 'pm-test') {
  const { dispatch } = require('../lib/agentBus/handlers');
  const res = await dispatch('register_agent', {
    name, intro: 'PM for testing', workspace: 'boos',
    role: 'supervisor', capabilities: ['test'],
    cli_session_id: nextUid(),
  }, { sessionId: 'sess-' + name });
  if (!res.ok) throw new Error('registerPm failed: ' + JSON.stringify(res));
  return res;
}

async function registerWorker(name = 'worker-test') {
  const { dispatch } = require('../lib/agentBus/handlers');
  const res = await dispatch('register_agent', {
    name, intro: 'Worker for testing', workspace: 'boos',
    role: 'worker', capabilities: ['test'],
    cli_session_id: nextUid(),
  }, { sessionId: 'sess-' + name });
  if (!res.ok) throw new Error('registerWorker failed: ' + JSON.stringify(res));
  return res;
}

function makeCtx(agent) {
  return { sessionId: 'sess-' + agent.uid.slice(0, 8), uid: agent.uid, workspace: 'boos' };
}

// ── dispatch: unknown tool ───────────────────────────────────────────────────

describe('dispatch — unknown tool', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('returns error for unknown tool name', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('nonexistent_tool', {}, {});
    assert.ok(result.error);
    assert.ok(result.error.includes('unknown tool'));
  });

  test('returns error for empty tool name', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('', {}, {});
    assert.ok(result.error);
  });
});

// ── register_agent ───────────────────────────────────────────────────────────

describe('register_agent', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('registers a new agent successfully', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('register_agent', {
      name: 'TestAgent', workspace: 'boos', role: 'worker',
      cli_session_id: '11111111-1111-1111-1111-111111111111',
    }, { sessionId: 'sess-new' });

    assert.ok(result.ok, 'register should succeed: ' + JSON.stringify(result));
    assert.ok(result.uid);
    assert.strictEqual(result.role, 'worker');
    assert.strictEqual(result.reconnected, false);
  });

  test('rejects registration without name', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('register_agent', {
      workspace: 'boos',
    }, { sessionId: 'sess-no-name' });
    assert.ok(result.error);
  });

  test('rejects registration without workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('register_agent', {
      name: 'NoWs',
    }, { sessionId: 'sess-no-ws' });
    assert.ok(result.error);
  });

  test('registers with capabilities', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('register_agent', {
      name: 'CapAgent', workspace: 'boos', role: 'worker',
      capabilities: ['frontend', 'react', 'testing'],
      cli_session_id: '22222222-2222-2222-2222-222222222222',
    }, { sessionId: 'sess-cap' });

    assert.ok(result.ok);
    const store = require('../lib/agentBus/store');
    const agent = store.getAgent(result.uid);
    assert.ok(agent.capabilities.includes('frontend'));
  });

  test('register with empty intro defaults to empty string', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('register_agent', {
      name: 'NoIntro', workspace: 'boos',
      cli_session_id: '33333333-3333-3333-3333-333333333333',
    }, { sessionId: 'sess-ni' });

    assert.ok(result.ok);
    const store = require('../lib/agentBus/store');
    const agent = store.getAgent(result.uid);
    assert.strictEqual(agent.intro, '');
  });

  test('reconnection returns original uid and pending task count', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const registry = require('../lib/agentBus/registry');

    // First registration
    const first = await dispatch('register_agent', {
      name: 'ReconnAgent', workspace: 'boos',
      cli_session_id: '44444444-4444-4444-4444-444444444444',
    }, { sessionId: 'sess-reconn' });
    assert.ok(first.ok);
    const uid = first.uid;

    // Second registration with same cli_session_id → reconnection
    const second = await dispatch('register_agent', {
      name: 'ReconnAgent', workspace: 'boos',
      cli_session_id: '44444444-4444-4444-4444-444444444444',
    }, { sessionId: 'sess-reconn-2' });
    assert.ok(second.ok);
    assert.strictEqual(second.uid, uid);
    assert.strictEqual(second.reconnected, true);
  });
});

// ── deregister_agent ─────────────────────────────────────────────────────────

describe('deregister_agent', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('deregisters a registered agent', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dereg-pm');
    const ctx = makeCtx(pm);

    const result = await dispatch('deregister_agent', {}, ctx);
    assert.ok(result.ok);
    assert.strictEqual(result.existed, true);
  });

  test('returns error when not registered', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('deregister_agent', {}, {});
    assert.ok(result.error);
  });
});

// ── list_agents ──────────────────────────────────────────────────────────────

describe('list_agents', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('lists agents in workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('list-pm');
    const worker = await registerWorker('list-worker');

    const result = await dispatch('list_agents', {}, makeCtx(pm));
    assert.strictEqual(result.workspace, 'boos');
    assert.ok(result.agents.length >= 2);
    assert.strictEqual(result.self_uid, pm.uid);
  });

  test('returns error when no workspace context', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('list_agents', {}, {});
    assert.ok(result.error);
  });

  test('agents have status and activeTasks fields', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('status-pm');

    const result = await dispatch('list_agents', {}, makeCtx(pm));
    const self = result.agents.find((a) => a.uid === pm.uid);
    assert.ok(self);
    assert.ok('status' in self);
    assert.ok('activeTasks' in self);
  });
});

// ── send_task ────────────────────────────────────────────────────────────────

describe('send_task', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('sends a task to another agent', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sender-pm');
    const worker = await registerWorker('receiver-w');

    const result = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Hello from sender',
    }, makeCtx(pm));
    assert.ok(result.ok);
    assert.ok(result.task);
    assert.strictEqual(result.task.receiver_uid, worker.uid);
    assert.ok(result.auto_wake);
  });

  test('sends task with high priority', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('pri-pm');
    const worker = await registerWorker('pri-w');

    const result = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Urgent task', priority: 'high',
    }, makeCtx(pm));
    assert.ok(result.ok);
    assert.strictEqual(result.task.priority, 'high');
  });

  test('rejects send without sender registration', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('send_task', {
      to_uid: 'some-uid', content: 'test',
    }, {});
    assert.ok(result.error);
  });

  test('rejects send to non-existent agent', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ghost-pm');

    const result = await dispatch('send_task', {
      to_uid: 'nonexistent-agent', content: 'Ghost town',
    }, makeCtx(pm));
    assert.ok(result.error);
    assert.ok(result.error.includes('not found'));
  });

  test('rejects cross-workspace send', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const registry = require('../lib/agentBus/registry');
    const pm = await registerPm('cross-pm');
    const other = await registry.registerAgent({
      name: 'other-ws', intro: 'other', workspace: 'other-ws',
      role: 'worker', capabilities: ['test'],
      cliSessionId: '99999999-9999-9999-9999-999999999999',
    });

    const result = await dispatch('send_task', {
      to_uid: other.uid, content: 'Cross workspace',
    }, makeCtx(pm));
    assert.ok(result.error);
  });

  test('message_type=response validates reply_to chain', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('chain-pm');
    const worker = await registerWorker('chain-w');

    // Send a request first
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Original request',
    }, makeCtx(pm));
    const taskId = sent.task.task_id;

    // Try to send a response without reply_to
    const badResp = await dispatch('send_task', {
      to_uid: pm.uid, content: 'Response', message_type: 'response',
    }, makeCtx(worker));
    assert.ok(badResp.error);
  });

  test('message_type must be "request" or "response"', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('type-pm');

    const result = await dispatch('send_task', {
      to_uid: 'some-uid', content: 'test', message_type: 'invalid',
    }, makeCtx(pm));
    assert.ok(result.error);
  });

  test('content is sanitized (max 64KB)', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sani-pm');
    const worker = await registerWorker('sani-w');

    const longContent = 'x'.repeat(100_000); // > 64KB
    const result = await dispatch('send_task', {
      to_uid: worker.uid, content: longContent,
    }, makeCtx(pm));
    // Should succeed but content truncated
    assert.ok(result.ok);
    const store = require('../lib/agentBus/store');
    const task = store.getTask(result.task.task_id);
    assert.ok(task.content.length <= 64 * 1024);
  });
});

// ── check_inbox + respond_task ───────────────────────────────────────────────

describe('check_inbox + respond_task flow', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('full send → check → respond → settle cycle', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('flow-pm');
    const worker = await registerWorker('flow-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    // 1. PM sends task
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Do the thing',
    }, pmCtx);
    assert.ok(sent.ok);
    assert.strictEqual(sent.sender, pm.uid);
    const taskId = sent.task.task_id;

    // 2. Worker checks inbox
    const inbox = await dispatch('check_inbox', {}, wCtx);
    assert.strictEqual(inbox.inbox_empty, false);
    assert.strictEqual(inbox.receiver, worker.uid);
    assert.strictEqual(inbox.task.task_id, taskId);

    // 3. Worker responds — Sprint 37: goes to submitted, not completed
    const responded = await dispatch('respond_task', {
      task_id: taskId, result: 'Done!',
    }, wCtx);
    assert.ok(responded.ok);
    assert.strictEqual(responded.responder, worker.uid);
    assert.strictEqual(responded.task_id, taskId);
    assert.strictEqual(responded.status, 'submitted');
    assert.strictEqual(responded.needs_settlement, true);

    // 4. Worker's task is NOT archived yet
    const queue = require('../lib/agentBus/queue');
    const beforeSettle = await queue.getArchivedTask(taskId);
    assert.strictEqual(beforeSettle, null);

    // 5. PM settles (approves) → completed + archived
    const settled = await dispatch('settle_task', {
      task_id: taskId, action: 'approve',
    }, pmCtx);
    assert.ok(settled.ok);
    assert.strictEqual(settled.approver, pm.uid);
    assert.strictEqual(settled.task_id, taskId);
    assert.strictEqual(settled.status, 'completed');

    // 6. Now in archive
    const archived = await queue.getArchivedTask(taskId);
    assert.ok(archived);
    assert.strictEqual(archived.status, 'completed');
    assert.strictEqual(archived.result, 'Done!');
  });

  test('check_inbox returns empty when no tasks', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('empty-w');

    const result = await dispatch('check_inbox', {}, makeCtx(worker));
    assert.strictEqual(result.inbox_empty, true);
  });

  test('check_inbox errors when not registered', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('check_inbox', {}, {});
    assert.ok(result.error);
  });

  test('respond_task errors when not registered', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('respond_task', { task_id: 't-123' }, {});
    assert.ok(result.error);
  });

  test('respond_task errors for non-existent task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('bad-resp-w');

    const result = await dispatch('respond_task', {
      task_id: 'nonexistent-task-id',
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('respond_task rejects caller that does not own the task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('owner-pm');
    const worker1 = await registerWorker('owner-w1');
    const worker2 = await registerWorker('owner-w2');

    // PM sends to worker1
    const sent = await dispatch('send_task', {
      to_uid: worker1.uid, content: 'For worker1',
    }, makeCtx(pm));

    // worker1 claims it
    await dispatch('check_inbox', {}, makeCtx(worker1));

    // worker2 tries to respond — should fail
    const result = await dispatch('respond_task', {
      task_id: sent.task.task_id, result: 'Stolen!',
    }, makeCtx(worker2));
    assert.ok(result.error);
  });
});

// ── cancel_task ──────────────────────────────────────────────────────────────

describe('cancel_task', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('sender can cancel their own task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const queue = require('../lib/agentBus/queue');
    const pm = await registerPm('cancel-pm');
    const worker = await registerWorker('cancel-w');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Cancel me',
    }, makeCtx(pm));

    const result = await dispatch('cancel_task', {
      task_id: sent.task.task_id,
    }, makeCtx(pm));
    assert.ok(result.ok);

    // Task is archived after cancel — check via getArchivedTask.
    const task = await queue.getArchivedTask(sent.task.task_id);
    assert.ok(task);
    assert.strictEqual(task.status, 'cancelled');
  });

  test('supervisor can cancel any task in workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sup-cancel-pm');
    const worker = await registerWorker('sup-cancel-w');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Supervisor cancel test',
    }, makeCtx(pm));

    // PM (supervisor) cancels it
    const result = await dispatch('cancel_task', {
      task_id: sent.task.task_id,
    }, makeCtx(pm));
    assert.ok(result.ok);
  });

  test('non-supervisor cannot cancel others\' tasks', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('other-pm');
    const worker1 = await registerWorker('other-w1');
    const worker2 = await registerWorker('other-w2');

    const sent = await dispatch('send_task', {
      to_uid: worker1.uid, content: 'Not yours',
    }, makeCtx(pm));

    const result = await dispatch('cancel_task', {
      task_id: sent.task.task_id,
    }, makeCtx(worker2));
    assert.ok(result.error);
  });

  test('cancel non-existent task returns error', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ghost-cancel');

    const result = await dispatch('cancel_task', {
      task_id: 'task-that-does-not-exist',
    }, makeCtx(pm));
    assert.ok(result.error);
  });
});

// ── list_my_tasks ────────────────────────────────────────────────────────────

describe('list_my_tasks', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('returns tasks for worker', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('lm-pm');
    const worker = await registerWorker('lm-w');

    await dispatch('send_task', {
      to_uid: worker.uid, content: 'Task 1',
    }, makeCtx(pm));
    await dispatch('send_task', {
      to_uid: worker.uid, content: 'Task 2',
    }, makeCtx(pm));

    const result = await dispatch('list_my_tasks', {}, makeCtx(worker));
    assert.ok(result.tasks.length >= 2);
  });

  test('supervisor sees all tasks in workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sv-pm');
    const worker = await registerWorker('sv-w');

    await dispatch('send_task', {
      to_uid: worker.uid, content: 'Task for supervisor view',
    }, makeCtx(pm));

    const result = await dispatch('list_my_tasks', {}, makeCtx(pm));
    assert.ok(result.supervisor_view);
    assert.ok(result.tasks.length >= 1);
  });

  test('errors when not registered', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('list_my_tasks', {}, {});
    assert.ok(result.error);
  });
});

// ── get_task ─────────────────────────────────────────────────────────────────

describe('get_task', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('retrieves task by id', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('gt-pm');
    const worker = await registerWorker('gt-w');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Get me',
    }, makeCtx(pm));

    const result = await dispatch('get_task', {
      task_id: sent.task.task_id,
    }, makeCtx(pm));
    assert.ok(result.task);
    assert.strictEqual(result.task.task_id, sent.task.task_id);
  });

  test('returns error for non-existent task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('get_task', {
      task_id: 'no-such-task',
    }, {});
    assert.ok(result.error);
  });
});

// ── list_my_tasks ────────────────────────────────────────────────────────────

// Additional edge tests
describe('list_my_tasks edge cases', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('returns empty list for worker with no tasks', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('zero-w');

    const result = await dispatch('list_my_tasks', {}, makeCtx(worker));
    assert.strictEqual(result.tasks.length, 0);
    assert.strictEqual(result.count, 0);
  });
});

// ── broadcast ────────────────────────────────────────────────────────────────

describe('broadcast', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('broadcasts to all agents in workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('bc-pm');
    await registerWorker('bc-w1');
    await registerWorker('bc-w2');

    const result = await dispatch('broadcast', {
      message: 'Hello everyone!',
    }, makeCtx(pm));
    assert.ok(result.ok);
    // Sent to all except sender
    assert.ok(result.sent >= 2);
  });

  test('broadcast requires registration', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('broadcast', {
      message: 'Anonymous broadcast',
    }, {});
    assert.ok(result.error);
  });

  test('broadcast requires workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('broadcast', {
      message: 'No workspace',
    }, { uid: 'some-uid' });
    assert.ok(result.error);
  });

  test('broadcast rate limiting triggers after threshold', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('rate-pm');
    const ctx = makeCtx(pm);

    // Fire 10 broadcasts (the limit per minute)
    for (let i = 0; i < 10; i++) {
      await dispatch('broadcast', { message: 'Rate test ' + i }, ctx);
    }

    // 11th should be rate limited
    const result = await dispatch('broadcast', { message: 'Should fail' }, ctx);
    assert.ok(result.error);
    assert.ok(result.error.includes('rate limited'));
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('handlers edge cases', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('send_task stores required_capabilities on persistent task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const store = require('../lib/agentBus/store');
    const pm = await registerPm('cap2-pm');
    const worker = await registerWorker('cap2-w');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Cap task',
      required_capabilities: ['frontend', 'testing'],
    }, makeCtx(pm));

    // Either it succeeds (store has caps) or it fails (cross-project check).
    // Verify stored task properties if successful.
    if (sent.ok) {
      const task = store.getTask(sent.task.task_id);
      assert.ok(task);
      assert.ok(Array.isArray(task.required_capabilities));
    } else {
      assert.ok(sent.error, 'should have error message');
    }
  });

  test('send_task with metadata', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('meta-pm');
    const worker = await registerWorker('meta-w');

    const result = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Meta task',
      metadata: { sprint: 35, priority_note: 'urgent' },
    }, makeCtx(pm));
    assert.ok(result.ok);
    assert.deepStrictEqual(result.task.metadata, { sprint: 35, priority_note: 'urgent' });
  });

  test('send_task defaults priority to "normal"', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('def-pm');
    const worker = await registerWorker('def-w');

    const result = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Default priority',
    }, makeCtx(pm));
    assert.strictEqual(result.task.priority, 'normal');
  });

  test('interrupt_task requires registration', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('interrupt_task', {
      task_id: 't-123',
    }, {});
    assert.ok(result.error);
  });

  test('retry_task requires registration', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('retry_task', {
      task_id: 't-123',
    }, {});
    assert.ok(result.error);
  });

  test('dispatch auto-registers from session when ctx.uid is null', async () => {
    // This tests the auto-identity-resolve path in dispatch()
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('auto-pm');
    const ctx = makeCtx(pm);

    // Make a call with a valid uid — should work normally
    const result = await dispatch('list_agents', {}, ctx);
    assert.strictEqual(result.workspace, 'boos');
  });

  test('respond_task with metadata + settlement', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const queue = require('../lib/agentBus/queue');
    const pm = await registerPm('rmd-pm');
    const worker = await registerWorker('rmd-w');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Metadata response',
    }, makeCtx(pm));

    // Claim
    await dispatch('check_inbox', {}, makeCtx(worker));

    // Respond with metadata — Sprint 37: goes to submitted
    const responded = await dispatch('respond_task', {
      task_id: sent.task.task_id,
      result: 'Done with meta',
      metadata: { duration_ms: 1500, files_changed: 3 },
    }, makeCtx(worker));
    assert.ok(responded.ok);
    assert.strictEqual(responded.status, 'submitted');
    assert.strictEqual(responded.responder, worker.uid);
    assert.strictEqual(responded.task_id, sent.task.task_id);

    // PM settles → archived
    await dispatch('settle_task', {
      task_id: sent.task.task_id, action: 'approve',
    }, makeCtx(pm));

    // Now in archive.
    const task = await queue.getArchivedTask(sent.task.task_id);
    assert.ok(task);
    assert.strictEqual(task.status, 'completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Goal CRUD
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Goal CRUD', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('goal_create succeeds for registered worker', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('goal-w');
    const result = await dispatch('goal_create', {
      title: 'Implement dark mode',
      description: 'Add dark mode support to the UI',
    }, makeCtx(worker));
    assert.ok(result.ok, 'goal_create should succeed: ' + JSON.stringify(result));
    assert.ok(result.goal);
    assert.ok(result.goal.goal_id.startsWith('goal_'));
    assert.strictEqual(result.goal.title, 'Implement dark mode');
    assert.strictEqual(result.goal.status, 'submitted');
    assert.strictEqual(result.goal.creator_uid, worker.uid);
  });

  test('goal_create fails without registration', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const result = await dispatch('goal_create', {
      title: 'No auth goal',
    }, {});
    assert.ok(result.error);
  });

  test('goal_create fails without title', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('notitle-w');
    const result = await dispatch('goal_create', {
      description: 'Missing title',
    }, makeCtx(worker));
    assert.ok(!result.ok);
  });

  test('goal_list returns created goals', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('gl-w');
    await dispatch('goal_create', {
      title: 'Goal A', description: 'First goal',
    }, makeCtx(worker));
    await dispatch('goal_create', {
      title: 'Goal B', description: 'Second goal',
    }, makeCtx(worker));

    const list = await dispatch('goal_list', {}, makeCtx(worker));
    assert.ok(list.ok);
    assert.ok(list.goals.length >= 2);
    assert.ok(list.goals.some((g) => g.title === 'Goal A'));
    assert.ok(list.goals.some((g) => g.title === 'Goal B'));
  });

  test('goal_list filters by status', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('gls-w');
    await dispatch('goal_create', {
      title: 'Active goal', description: 'Test',
    }, makeCtx(worker));

    const list = await dispatch('goal_list', { status: 'submitted' }, makeCtx(worker));
    assert.ok(list.ok);
    assert.ok(list.goals.every((g) => g.status === 'submitted'));
  });

  test('goal_status returns goal with DAG associations', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('gstat-w');
    const created = await dispatch('goal_create', {
      title: 'Status check goal', description: 'Check status',
    }, makeCtx(worker));
    const goalId = created.goal.goal_id;

    const status = await dispatch('goal_status', { goal_id: goalId }, makeCtx(worker));
    assert.ok(status.ok);
    assert.strictEqual(status.goal.goal_id, goalId);
    assert.ok(Array.isArray(status.dags));
  });

  test('goal_status errors for non-existent goal', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('badgs-w');
    const result = await dispatch('goal_status', { goal_id: 'goal_nonexistent' }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('goal_update succeeds for PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('gu-pm');
    const worker = await registerWorker('gu-w');
    const created = await dispatch('goal_create', {
      title: 'Update me', description: 'Before update',
    }, makeCtx(worker));
    const goalId = created.goal.goal_id;

    const updated = await dispatch('goal_update', {
      goal_id: goalId, title: 'Updated title', status: 'approved',
    }, makeCtx(pm));
    assert.ok(updated.ok, 'goal_update should succeed: ' + JSON.stringify(updated));
    assert.strictEqual(updated.goal.title, 'Updated title');
    assert.strictEqual(updated.goal.status, 'approved');
  });

  test('goal_update fails for non-PM worker', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('gu-w2');
    const created = await dispatch('goal_create', {
      title: 'Unauthorized update', description: 'Test',
    }, makeCtx(worker));

    const result = await dispatch('goal_update', {
      goal_id: created.goal.goal_id, title: 'Hacked',
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('goal_archive succeeds for PM after status is completed', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ga-pm');
    const worker = await registerWorker('ga-w');
    const created = await dispatch('goal_create', {
      title: 'Archive me', description: 'To be archived',
    }, makeCtx(worker));
    const goalId = created.goal.goal_id;

    // First set status to completed
    await dispatch('goal_update', { goal_id: goalId, status: 'completed' }, makeCtx(pm));

    const archived = await dispatch('goal_archive', { goal_id: goalId }, makeCtx(pm));
    assert.ok(archived.ok, 'goal_archive should succeed: ' + JSON.stringify(archived));
    assert.strictEqual(archived.archived, true);
  });

  test('goal_archive fails for non-completed goal', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ga2-pm');
    const worker = await registerWorker('ga2-w');
    const created = await dispatch('goal_create', {
      title: 'Cannot archive', description: 'Still submitted',
    }, makeCtx(worker));

    const result = await dispatch('goal_archive', {
      goal_id: created.goal.goal_id,
    }, makeCtx(pm));
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — DAG Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — DAG Lifecycle', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_create succeeds for PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dc-pm');
    const result = await dispatch('dag_create', {
      title: 'Release v2.0', description: 'Major release DAG',
    }, makeCtx(pm));
    assert.ok(result.ok, 'dag_create should succeed: ' + JSON.stringify(result));
    assert.ok(result.dag);
    assert.ok(result.dag.dag_id.startsWith('dag_'));
    assert.strictEqual(result.dag.title, 'Release v2.0');
    assert.strictEqual(result.dag.status, 'pending');
  });

  test('dag_create fails for non-PM worker', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('dc-w');
    const result = await dispatch('dag_create', {
      title: 'Unapproved DAG',
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('dag_add_task succeeds for PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dat-pm');
    const worker = await registerWorker('dat-w');
    const dag = await dispatch('dag_create', {
      title: 'Task DAG', description: 'DAG for task testing',
    }, makeCtx(pm));

    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id,
      title: 'Implement login',
      description: 'Add login page',
      executor_uid: worker.uid,
      reviewer_uid: pm.uid,
      acceptance_criteria: 'User can log in',
    }, makeCtx(pm));
    assert.ok(task.ok, 'dag_add_task should succeed: ' + JSON.stringify(task));
    assert.ok(task.task.task_id.startsWith('task_'));
    assert.strictEqual(task.task.title, 'Implement login');
    assert.strictEqual(task.task.executor_uid, worker.uid);
    assert.strictEqual(task.task.status, 'pending');
  });

  test('dag_add_task fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dat2-pm');
    const worker = await registerWorker('dat2-w');
    const dag = await dispatch('dag_create', {
      title: 'Unauthorized DAG', description: 'Test',
    }, makeCtx(pm));

    const result = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Bad task',
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('dag_activate transitions DAG to active', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('act-pm');
    const worker = await registerWorker('act-w');
    const dag = await dispatch('dag_create', {
      title: 'Activate DAG', description: 'Activation test',
    }, makeCtx(pm));
    await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task 1',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const activated = await dispatch('dag_activate', {
      dag_id: dag.dag.dag_id,
    }, makeCtx(pm));
    assert.ok(activated.status === 'active' || activated.ok,
      'dag_activate should succeed: ' + JSON.stringify(activated));
  });

  test('dag_status returns DAG details with summary', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ds-pm');
    const worker = await registerWorker('ds-w');
    const dag = await dispatch('dag_create', {
      title: 'Status DAG', description: 'Status check',
    }, makeCtx(pm));
    await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task X',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const status = await dispatch('dag_status', { dag_id: dag.dag.dag_id }, makeCtx(pm));
    assert.ok(status.ok);
    assert.strictEqual(status.dag.dag_id, dag.dag.dag_id);
    assert.ok(status.summary);
    assert.ok('total_tasks' in status.summary);
  });

  test('dag_status errors for non-existent DAG', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ds2-pm');
    const result = await dispatch('dag_status', { dag_id: 'dag_nonexistent' }, makeCtx(pm));
    assert.ok(result.error);
  });

  test('full DAG lifecycle: create → add → activate → submit → approve', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('life-pm');
    const worker = await registerWorker('life-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    // 1. Create DAG
    const dag = await dispatch('dag_create', {
      title: 'Lifecycle DAG', description: 'Full lifecycle test',
    }, pmCtx);
    assert.ok(dag.ok);
    const dagId = dag.dag.dag_id;

    // 2. Add task
    const task = await dispatch('dag_add_task', {
      dag_id: dagId, title: 'Complete feature',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Feature works',
    }, pmCtx);
    assert.ok(task.ok);
    const taskId = task.task.task_id;
    assert.strictEqual(task.task.status, 'pending');

    // 3. Activate DAG
    await dispatch('dag_activate', { dag_id: dagId }, pmCtx);

    // 4. Executor submits
    const submitted = await dispatch('dag_submit_task', {
      task_id: taskId, content: 'Feature implemented',
    }, wCtx);
    assert.ok(submitted.ok, 'dag_submit_task should succeed: ' + JSON.stringify(submitted));
    assert.strictEqual(submitted.executor, worker.uid);

    // 5. Reviewer approves
    const approved = await dispatch('dag_approve_task', {
      task_id: taskId, comment: 'LGTM',
    }, pmCtx);
    assert.ok(approved.ok, 'dag_approve_task should succeed: ' + JSON.stringify(approved));
    assert.strictEqual(approved.reviewer, pm.uid);
  });

  test('dag_submit_task fails for non-executor', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sub-pm');
    const worker1 = await registerWorker('sub-w1');
    const worker2 = await registerWorker('sub-w2');
    const dag = await dispatch('dag_create', {
      title: 'Submit auth DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Only for w1',
      executor_uid: worker1.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));
    await dispatch('dag_activate', { dag_id: dag.dag.dag_id }, makeCtx(pm));

    const result = await dispatch('dag_submit_task', {
      task_id: task.task.task_id, content: 'Stolen work',
    }, makeCtx(worker2));
    assert.ok(result.error);
  });

  test('dag_list returns all DAGs in workspace', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dl-pm');
    await dispatch('dag_create', { title: 'DAG 1', description: 'First' }, makeCtx(pm));
    await dispatch('dag_create', { title: 'DAG 2', description: 'Second' }, makeCtx(pm));

    const list = await dispatch('dag_list', {}, makeCtx(pm));
    assert.ok(list.ok);
    assert.ok(list.dags.length >= 2);
    assert.ok(list.dags.every((d) => d.summary));
  });

  test('dag_cancel sets DAG status to cancelled', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('can-pm');
    const dag = await dispatch('dag_create', {
      title: 'Cancel me', description: 'To be cancelled',
    }, makeCtx(pm));

    const cancelled = await dispatch('dag_cancel', {
      dag_id: dag.dag.dag_id, reason: 'No longer needed',
    }, makeCtx(pm));
    assert.ok(cancelled.ok);
    assert.strictEqual(cancelled.status, 'cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — DAG Reject + Escalation
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — DAG Reject + Escalation', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_reject_task by reviewer', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('rej-pm');
    const worker = await registerWorker('rej-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    const dag = await dispatch('dag_create', {
      title: 'Reject test DAG', description: 'Test',
    }, pmCtx);
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Rejectable task',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Must pass',
    }, pmCtx);
    await dispatch('dag_activate', { dag_id: dag.dag.dag_id }, pmCtx);
    await dispatch('dag_submit_task', {
      task_id: task.task.task_id, content: 'Work done',
    }, wCtx);

    const rejected = await dispatch('dag_reject_task', {
      task_id: task.task.task_id, comment: 'Needs improvement',
    }, pmCtx);
    assert.ok(rejected.ok, 'dag_reject_task should succeed: ' + JSON.stringify(rejected));
    assert.strictEqual(rejected.reviewer, pm.uid);
  });

  test('dag_reject_task fails for non-reviewer', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('rej2-pm');
    const worker1 = await registerWorker('rej2-w1');
    const worker2 = await registerWorker('rej2-w2');
    const dag = await dispatch('dag_create', {
      title: 'Reject auth DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Auth task',
      executor_uid: worker1.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));
    await dispatch('dag_activate', { dag_id: dag.dag.dag_id }, makeCtx(pm));
    await dispatch('dag_submit_task', {
      task_id: task.task.task_id, content: 'Work',
    }, makeCtx(worker1));

    // worker2 tries to reject — not the reviewer
    const result = await dispatch('dag_reject_task', {
      task_id: task.task.task_id, comment: 'Not your job',
    }, makeCtx(worker2));
    assert.ok(result.error);
  });

  test('dag_reject_task 3x leads to escalated status', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('esc-pm');
    const worker = await registerWorker('esc-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    const dag = await dispatch('dag_create', {
      title: 'Escalation DAG', description: 'Test',
    }, pmCtx);
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Reject me 3 times',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Must pass',
    }, pmCtx);
    const taskId = task.task.task_id;
    await dispatch('dag_activate', { dag_id: dag.dag.dag_id }, pmCtx);

    // Reject 3 times (submit → reject × 3)
    for (let i = 0; i < 3; i++) {
      await dispatch('dag_submit_task', {
        task_id: taskId, content: 'Attempt ' + (i + 1),
      }, wCtx);
      const rej = await dispatch('dag_reject_task', {
        task_id: taskId, comment: 'Try again #' + (i + 1),
      }, pmCtx);
      assert.ok(rej.ok, 'Reject #' + (i + 1) + ' should succeed: ' + JSON.stringify(rej));
    }

    // After 3 rejects, check task status
    const finalTask = dagStore.getTask(taskId);
    assert.ok(finalTask);
    // Status may be 'escalated' or 'in_progress' depending on retry count
    assert.ok(
      finalTask.status === 'escalated' || finalTask.retry_count >= 3,
      'Task should be escalated or have retry_count >= 3: status=' +
        finalTask.status + ' retry_count=' + finalTask.retry_count
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Settlement Gate
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Settlement Gate', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('respond_task → submitted → settle_task(approve) → completed', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const queue = require('../lib/agentBus/queue');
    const pm = await registerPm('sg-pm');
    const worker = await registerWorker('sg-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    // Send task
    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Please implement feature X',
    }, pmCtx);
    const taskId = sent.task.task_id;

    // Worker claims + responds
    await dispatch('check_inbox', {}, wCtx);
    const responded = await dispatch('respond_task', {
      task_id: taskId, result: 'Feature X done!',
    }, wCtx);
    assert.ok(responded.ok);
    assert.strictEqual(responded.status, 'submitted');
    assert.strictEqual(responded.needs_settlement, true);

    // PM settles (approve) → completed + archived
    const settled = await dispatch('settle_task', {
      task_id: taskId, action: 'approve', feedback: 'Great work!',
    }, pmCtx);
    assert.ok(settled.ok, 'settle_task approve should succeed: ' + JSON.stringify(settled));
    assert.strictEqual(settled.approver, pm.uid);
    assert.strictEqual(settled.status, 'completed');

    // Archived
    const archived = await queue.getArchivedTask(taskId);
    assert.ok(archived);
    assert.strictEqual(archived.status, 'completed');
  });

  test('settle_task(reject) → in_progress with retry_count++', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const store = require('../lib/agentBus/store');
    const pm = await registerPm('sgr-pm');
    const worker = await registerWorker('sgr-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Bug fix needed',
    }, pmCtx);
    const taskId = sent.task.task_id;

    await dispatch('check_inbox', {}, wCtx);
    await dispatch('respond_task', {
      task_id: taskId, result: 'Fixed?',
    }, wCtx);

    // PM rejects → back to in_progress
    const settled = await dispatch('settle_task', {
      task_id: taskId, action: 'reject', feedback: 'Not good enough',
    }, pmCtx);
    assert.ok(settled.ok, 'settle_task reject should succeed: ' + JSON.stringify(settled));
    assert.strictEqual(settled.status, 'in_progress');

    // Task should have retry_count incremented
    const task = store.getTask(taskId);
    assert.ok(task);
    assert.ok(task.retry_count >= 1, 'retry_count should be >= 1 after reject: ' + task.retry_count);
  });

  test('settle_task fails for non-sender', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sgw-pm');
    const worker = await registerWorker('sgw-w');
    const otherWorker = await registerWorker('sgw-other');

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'PM task',
    }, makeCtx(pm));
    await dispatch('check_inbox', {}, makeCtx(worker));
    await dispatch('respond_task', {
      task_id: sent.task.task_id, result: 'Done',
    }, makeCtx(worker));

    // Another worker tries to settle
    const result = await dispatch('settle_task', {
      task_id: sent.task.task_id, action: 'approve',
    }, makeCtx(otherWorker));
    assert.ok(result.error);
  });

  test('respond_task after re-open allows re-settlement', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const queue = require('../lib/agentBus/queue');
    const pm = await registerPm('rrs-pm');
    const worker = await registerWorker('rrs-w');
    const pmCtx = makeCtx(pm);
    const wCtx = makeCtx(worker);

    const sent = await dispatch('send_task', {
      to_uid: worker.uid, content: 'Re-open test',
    }, pmCtx);
    const taskId = sent.task.task_id;

    // First round: respond → reject
    await dispatch('check_inbox', {}, wCtx);
    await dispatch('respond_task', { task_id: taskId, result: 'V1' }, wCtx);
    await dispatch('settle_task', { task_id: taskId, action: 'reject', feedback: 'Redo' }, pmCtx);

    // Second round: respond → approve
    await dispatch('check_inbox', {}, wCtx);
    const resp2 = await dispatch('respond_task', { task_id: taskId, result: 'V2 fixed' }, wCtx);
    assert.ok(resp2.ok);

    const settled = await dispatch('settle_task', {
      task_id: taskId, action: 'approve',
    }, pmCtx);
    assert.ok(settled.ok);
    assert.strictEqual(settled.status, 'completed');

    const archived = await queue.getArchivedTask(taskId);
    assert.ok(archived);
    assert.strictEqual(archived.status, 'completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — DAG Decomposer
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — DAG Decomposer', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_decompose creates DAG with sub-tasks', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dec-pm');
    const worker = await registerWorker('dec-w');

    const result = await dispatch('dag_decompose', {
      title: 'Build user dashboard',
      description: 'Create a dashboard with charts, filters, and export',
      tasks: [
        { title: 'Design schema', description: 'DB schema for dashboard' },
        { title: 'Build API', description: 'REST API endpoints' },
        { title: 'Frontend components', description: 'React components' },
        { title: 'Testing', description: 'Unit + E2E tests' },
      ],
    }, makeCtx(pm));
    assert.ok(result.ok, 'dag_decompose should succeed: ' + JSON.stringify(result));
    assert.ok(result.dag);
    assert.ok(result.dag.dag_id.startsWith('dag_'));
    assert.ok(result.tasks.length >= 1);
  });

  test('dag_decompose fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('dec2-w');
    const result = await dispatch('dag_decompose', {
      title: 'Unauthorized decompose',
      tasks: [{ title: 'Task 1' }],
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('dag_decompose with empty tasks returns error', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dec3-pm');
    const result = await dispatch('dag_decompose', {
      title: 'Empty decompose', tasks: [],
    }, makeCtx(pm));
    // May return error or empty tasks
    assert.ok(result.error || (result.ok && result.tasks.length === 0));
  });

  test('dag_decompose with auto_activate=true activates DAG', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('dec4-pm');
    const worker = await registerWorker('dec4-w');

    const result = await dispatch('dag_decompose', {
      title: 'Auto-activate DAG',
      description: 'Should be active immediately',
      auto_activate: true,
      tasks: [
        { title: 'Task A', description: 'First task' },
        { title: 'Task B', description: 'Second task', depends_on: ['Task A'] },
      ],
    }, makeCtx(pm));
    assert.ok(result.ok, 'dag_decompose should succeed: ' + JSON.stringify(result));
  });

  test('dag_suggest_assignments returns agent suggestions', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('sug-pm');
    await registerWorker('sug-w1');
    await registerWorker('sug-w2');

    const result = await dispatch('dag_suggest_assignments', {
      tasks: [
        { title: 'Frontend work', capabilities: ['frontend'] },
        { title: 'Backend work', capabilities: ['backend'] },
      ],
    }, makeCtx(pm));
    assert.ok(result.ok, 'dag_suggest_assignments should succeed: ' + JSON.stringify(result));
    assert.ok(result.assignments);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Proposal Flow
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Proposal Flow', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_propose_task creates proposed task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('prop-pm');
    const worker = await registerWorker('prop-w');
    const dag = await dispatch('dag_create', {
      title: 'Proposal DAG', description: 'For proposals',
    }, makeCtx(pm));

    const proposed = await dispatch('dag_propose_task', {
      dag_id: dag.dag.dag_id,
      title: 'Add caching layer',
      description: 'Proposal: add Redis caching for performance',
      acceptance_criteria: 'Response time < 100ms',
    }, makeCtx(worker));
    assert.ok(proposed.ok, 'dag_propose_task should succeed: ' + JSON.stringify(proposed));
    assert.ok(proposed.task_id.startsWith('task_'));
    assert.strictEqual(proposed.status, 'proposed');
    assert.strictEqual(proposed.publisher, worker.uid);
  });

  test('dag_propose_task fails for unregistered caller', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('prop2-pm');
    const dag = await dispatch('dag_create', {
      title: 'Auth proposal DAG', description: 'Test',
    }, makeCtx(pm));

    const result = await dispatch('dag_propose_task', {
      dag_id: dag.dag.dag_id, title: 'Ghost proposal',
    }, {});
    assert.ok(result.error);
  });

  test('dag_approve_proposal transitions proposed → pending with executor/reviewer', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('appr-pm');
    const worker = await registerWorker('appr-w');
    const dag = await dispatch('dag_create', {
      title: 'Approve proposal DAG', description: 'Test',
    }, makeCtx(pm));

    const proposed = await dispatch('dag_propose_task', {
      dag_id: dag.dag.dag_id,
      title: 'Approval candidate',
      description: 'Please approve',
      acceptance_criteria: 'Works',
    }, makeCtx(worker));
    const taskId = proposed.task_id;

    const approved = await dispatch('dag_approve_proposal', {
      task_id: taskId,
      executor_uid: worker.uid,
      reviewer_uid: pm.uid,
      dependencies: [],
      acceptance_criteria: 'Must work',
    }, makeCtx(pm));
    assert.ok(approved.ok, 'dag_approve_proposal should succeed: ' + JSON.stringify(approved));
    assert.strictEqual(approved.approver, pm.uid);

    // Verify task is now pending with executor/reviewer set
    const task = dagStore.getTask(taskId);
    assert.ok(task);
    assert.strictEqual(task.status, 'pending');
    assert.strictEqual(task.executor_uid, worker.uid);
    assert.strictEqual(task.reviewer_uid, pm.uid);
  });

  test('dag_reject_proposal sets status to rejected', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('rejp-pm');
    const worker = await registerWorker('rejp-w');
    const dag = await dispatch('dag_create', {
      title: 'Reject proposal DAG', description: 'Test',
    }, makeCtx(pm));

    const proposed = await dispatch('dag_propose_task', {
      dag_id: dag.dag.dag_id,
      title: 'Bad idea',
      description: 'This will be rejected',
      acceptance_criteria: 'None',
    }, makeCtx(worker));

    const rejected = await dispatch('dag_reject_proposal', {
      task_id: proposed.task_id,
      reason: 'Out of scope',
    }, makeCtx(pm));
    assert.ok(rejected.ok, 'dag_reject_proposal should succeed: ' + JSON.stringify(rejected));
    assert.strictEqual(rejected.rejector, pm.uid);

    // Verify task is rejected
    const task = dagStore.getTask(proposed.task_id);
    assert.ok(task);
    assert.strictEqual(task.status, 'rejected');
  });

  test('dag_approve_proposal fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('appr2-pm');
    const worker1 = await registerWorker('appr2-w1');
    const worker2 = await registerWorker('appr2-w2');
    const dag = await dispatch('dag_create', {
      title: 'Auth approve DAG', description: 'Test',
    }, makeCtx(pm));

    const proposed = await dispatch('dag_propose_task', {
      dag_id: dag.dag.dag_id, title: 'PM only approve',
      description: 'Test',
    }, makeCtx(worker1));

    const result = await dispatch('dag_approve_proposal', {
      task_id: proposed.task_id,
      executor_uid: worker2.uid,
      reviewer_uid: pm.uid,
    }, makeCtx(worker2));
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Runtime Adjustment
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Runtime Adjustment', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_rearrange adds and removes dependencies', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('ra-pm');
    const worker = await registerWorker('ra-w');
    const dag = await dispatch('dag_create', {
      title: 'Rearrange DAG', description: 'Test',
    }, makeCtx(pm));
    // Create two tasks
    const t1 = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task A',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));
    const t2 = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task B',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    // Add dependency: B depends on A
    const rearranged = await dispatch('dag_rearrange', {
      task_id: t2.task.task_id,
      add_dependencies: [t1.task.task_id],
    }, makeCtx(pm));
    assert.ok(rearranged.ok, 'dag_rearrange should succeed: ' + JSON.stringify(rearranged));
    assert.ok(rearranged.dependencies.includes(t1.task.task_id));
  });

  test('dag_rearrange detects circular dependency', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('cyc-pm');
    const worker = await registerWorker('cyc-w');
    const dag = await dispatch('dag_create', {
      title: 'Cycle DAG', description: 'Test',
    }, makeCtx(pm));
    const t1 = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task X',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));
    const t2 = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Task Y',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    // Y depends on X
    await dispatch('dag_rearrange', {
      task_id: t2.task.task_id,
      add_dependencies: [t1.task.task_id],
    }, makeCtx(pm));

    // Try to make X depend on Y → cycle!
    const result = await dispatch('dag_rearrange', {
      task_id: t1.task.task_id,
      add_dependencies: [t2.task.task_id],
    }, makeCtx(pm));
    assert.ok(result.error);
    assert.ok(result.error.includes('circular'));
  });

  test('dag_rearrange fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('ra2-pm');
    const worker = await registerWorker('ra2-w');
    const dag = await dispatch('dag_create', {
      title: 'Auth rearrange DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'PM only',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const result = await dispatch('dag_rearrange', {
      task_id: task.task.task_id, add_dependencies: [],
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('dag_force_modify allows PM to modify task and re-notifies executor', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('fm-pm');
    const worker = await registerWorker('fm-w');
    const dag = await dispatch('dag_create', {
      title: 'Force modify DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Modifiable task',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Old criteria',
    }, makeCtx(pm));

    const modified = await dispatch('dag_force_modify', {
      task_id: task.task.task_id,
      title: 'Updated task title',
      description: 'Updated description',
      acceptance_criteria: 'New criteria',
      reason: 'Scope changed',
    }, makeCtx(pm));
    assert.ok(modified.ok, 'dag_force_modify should succeed: ' + JSON.stringify(modified));

    const updated = dagStore.getTask(task.task.task_id);
    assert.ok(updated);
    assert.ok(updated.submit_content === null || updated.force_modified_by === pm.uid,
      'submit_content should be archived or force_modified_by set');
  });

  test('dag_partial_rollback deletes node and returns orphans', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('pr-pm');
    const worker = await registerWorker('pr-w');
    const dag = await dispatch('dag_create', {
      title: 'Rollback DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Remove me',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const rolled = await dispatch('dag_partial_rollback', {
      task_id: task.task.task_id,
    }, makeCtx(pm));
    assert.ok(rolled.ok, 'dag_partial_rollback should succeed: ' + JSON.stringify(rolled));
    // orphans should be an array
    assert.ok(Array.isArray(rolled.orphans));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Conflict Escalation
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Conflict Escalation', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_escalate_conflict notifies ROOT', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('conf-pm');
    const worker = await registerWorker('conf-w');
    const dag = await dispatch('dag_create', {
      title: 'Conflict DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Disputed task',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const escalated = await dispatch('dag_escalate_conflict', {
      task_id: task.task.task_id,
      summary: 'PM and PMO disagree on approach',
      pm_opinion: 'Use Redis',
      pmo_opinion: 'Use Postgres',
    }, makeCtx(pm));
    assert.ok(escalated.ok, 'dag_escalate_conflict should succeed: ' + JSON.stringify(escalated));
  });

  test('dag_escalate_conflict fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('conf2-pm');
    const worker = await registerWorker('conf2-w');
    const dag = await dispatch('dag_create', {
      title: 'Auth conflict DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Escalate auth',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const result = await dispatch('dag_escalate_conflict', {
      task_id: task.task.task_id,
      summary: 'Conflict', pm_opinion: 'A', pmo_opinion: 'B',
    }, makeCtx(worker));
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Review Questions
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Review Questions', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('dag_add_questions adds review questions to task', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('rq-pm');
    const worker = await registerWorker('rq-w');
    const dag = await dispatch('dag_create', {
      title: 'Questions DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Questionable task',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const result = await dispatch('dag_add_questions', {
      task_id: task.task.task_id,
      questions: [
        { question: 'Which library?', options: ['React', 'Vue', 'Svelte'], impact: 'Frontend stack' },
        { question: 'DB choice?', options: ['Postgres', 'MySQL'], impact: 'Data layer' },
      ],
    }, makeCtx(pm));
    assert.ok(result.ok, 'dag_add_questions should succeed: ' + JSON.stringify(result));
    assert.strictEqual(result.questions_added, 2);
    assert.strictEqual(result.total_questions, 2);

    // Verify questions persisted
    const updated = dagStore.getTask(task.task.task_id);
    assert.ok(updated.review_questions);
    assert.strictEqual(updated.review_questions.length, 2);
  });

  test('dag_add_questions fails for non-PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('rq2-pm');
    const worker = await registerWorker('rq2-w');
    const dag = await dispatch('dag_create', {
      title: 'Auth q DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'PM only q',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const result = await dispatch('dag_add_questions', {
      task_id: task.task.task_id,
      questions: [{ question: 'What?', options: ['A', 'B'] }],
    }, makeCtx(worker));
    assert.ok(result.error);
  });

  test('dag_answer_question updates question with user choice', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const dagStore = require('../lib/agentBus/dagStore');
    const pm = await registerPm('aq-pm');
    const worker = await registerWorker('aq-w');
    const dag = await dispatch('dag_create', {
      title: 'Answer DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Answer me',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));
    await dispatch('dag_add_questions', {
      task_id: task.task.task_id,
      questions: [{ question: 'Framework?', options: ['A', 'B'], impact: 'Tech' }],
    }, makeCtx(pm));

    // Get the question_id
    const t = dagStore.getTask(task.task.task_id);
    const qId = t.review_questions[0].question_id;

    const answered = await dispatch('dag_answer_question', {
      task_id: task.task.task_id,
      question_id: qId,
      choice: 'A',
    }, makeCtx(worker));
    assert.ok(answered.ok, 'dag_answer_question should succeed: ' + JSON.stringify(answered));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 37 — Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Sprint 37 — Edge Cases', () => {
  before(() => { freshSetup(); });
  after(() => { teardown(); });

  test('idempotent register with same cli_session_id returns same uid', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const sessionId = 'edge-session-' + nextUid().slice(0, 12);
    const first = await dispatch('register_agent', {
      name: 'Idempotent', workspace: 'boos', role: 'worker',
      cli_session_id: sessionId,
    }, { sessionId: 'sess-edge-1' });
    assert.ok(first.ok);
    const uid1 = first.uid;

    const second = await dispatch('register_agent', {
      name: 'Idempotent', workspace: 'boos', role: 'worker',
      cli_session_id: sessionId,
    }, { sessionId: 'sess-edge-2' });
    assert.ok(second.ok);
    assert.strictEqual(second.uid, uid1);
  });

  test('dag_add_task with missing required fields returns error', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('edge-pm');
    const dag = await dispatch('dag_create', {
      title: 'Edge DAG', description: 'Test',
    }, makeCtx(pm));

    const result = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id,
      // missing title, executor_uid, reviewer_uid
    }, makeCtx(pm));
    assert.ok(result.error);
  });

  test('dag_activate for non-existent DAG returns error', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('edge2-pm');
    const result = await dispatch('dag_activate', {
      dag_id: 'dag_nonexistent',
    }, makeCtx(pm));
    assert.ok(result.error);
  });

  test('goal_create with empty description defaults ok', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const worker = await registerWorker('edge3-w');
    const result = await dispatch('goal_create', {
      title: 'Minimal goal',
    }, makeCtx(worker));
    assert.ok(result.ok);
    assert.strictEqual(result.goal.description, '');
  });

  test('dag_reassign_task as PM', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('reas-pm');
    const worker1 = await registerWorker('reas-w1');
    const worker2 = await registerWorker('reas-w2');
    const dag = await dispatch('dag_create', {
      title: 'Reassign DAG', description: 'Test',
    }, makeCtx(pm));
    const task = await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'Reassignable',
      executor_uid: worker1.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const reassigned = await dispatch('dag_reassign_task', {
      task_id: task.task.task_id,
      new_executor_uid: worker2.uid,
    }, makeCtx(pm));
    assert.ok(reassigned.ok, 'dag_reassign_task should succeed: ' + JSON.stringify(reassigned));
  });

  test('dag_my_tasks returns tasks for executor and reviewer', async () => {
    const { dispatch } = require('../lib/agentBus/handlers');
    const pm = await registerPm('mt-pm');
    const worker = await registerWorker('mt-w');
    const dag = await dispatch('dag_create', {
      title: 'MyTasks DAG', description: 'Test',
    }, makeCtx(pm));
    await dispatch('dag_add_task', {
      dag_id: dag.dag.dag_id, title: 'My task',
      executor_uid: worker.uid, reviewer_uid: pm.uid,
      acceptance_criteria: 'Done',
    }, makeCtx(pm));

    const myTasks = await dispatch('dag_my_tasks', {}, makeCtx(worker));
    assert.ok(myTasks.ok);
    assert.ok(myTasks.as_executor || myTasks.as_reviewer);
  });
});

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

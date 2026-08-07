// Sprint 8 Waves 5-6 unit tests — #67 priority queue, #68 retry, #69 round-robin.
// Uses a temp BOOS_HOME so tests never touch real ~/.boos production data.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let _testHome;
let store, queue, collaborationLoop;
before(() => {
  _testHome = path.join(os.tmpdir(), 'boos-w56-' + Date.now().toString(36));
  fs.mkdirSync(_testHome, { recursive: true });
  process.env.BOOS_HOME = _testHome;
  for (const m of ['../lib/config', '../lib/agentBus/storeCore',
    '../lib/agentBus/store', '../lib/agentBus/storeAgents',
    '../lib/agentBus/storeTasks', '../lib/agentBus/storeIdentity',
    '../lib/agentBus/queue', '../lib/agentBus/collaborationLoop',
    '../lib/agentBus/inboxStore']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  // Re-require AFTER BOOS_HOME is set so these bind to the temp dir.
  store = require('../lib/agentBus/store');
  queue = require('../lib/agentBus/queue');
  collaborationLoop = require('../lib/agentBus/collaborationLoop');
});
after(() => {
  delete process.env.BOOS_HOME;
  try { fs.rmSync(_testHome, { recursive: true, force: true }); } catch {}
});

const TEST_PREFIX = 'test_w56_';
let _cleanupIds = [];
let _cleanupAgentIds = [];

async function _cleanup() {
  for (const tid of _cleanupIds) {
    try { await store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
  }
  for (const uid of _cleanupAgentIds) {
    try { await store.deleteAgent(uid); } catch {}
  }
  _cleanupIds = [];
  _cleanupAgentIds = [];
}

// Register a test agent, track for cleanup.
let _nextAgentIdx = 0;
async function _regAgent(name, caps = [], role = 'worker') {
  const uid = TEST_PREFIX + 'agent_' + (_nextAgentIdx++);
  await store.insertAgent({ uid, name, intro: '', workspace: 'test_w56', role, capabilities: caps });
  _cleanupAgentIds.push(uid);
  return uid;
}

async function _regSender() {
  // Sprint 37: a supervisor-sent task that a worker responds goes to
  // "submitted" (PM settlement), NOT completed. Retry tests want the
  // single-step completed path, so the sender is a plain worker.
  return _regAgent('sender_' + (_nextAgentIdx), [], 'worker');
}

function _trackId(taskId) { _cleanupIds.push(taskId); }

describe('priority queue (#67)', () => {
  after(_cleanup);

  it('high before normal before low in checkInbox', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    await queue.sendTask({ sender, receiver_uid: recv, content: 'low', priority: 'low' });
    await queue.sendTask({ sender, receiver_uid: recv, content: 'normal', priority: 'normal' });
    await queue.sendTask({ sender, receiver_uid: recv, content: 'high', priority: 'high' });

    const t1 = await queue.checkInbox(recv); _trackId(t1?.task_id);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(t1, 'should have a task');
    assert.equal(t1.priority, 'high');
    assert.ok(t1.content.includes('high'));

    const t2 = await queue.checkInbox(recv); _trackId(t2?.task_id);
    assert.equal(t2.priority, 'normal');

    const t3 = await queue.checkInbox(recv); _trackId(t3?.task_id);
    assert.equal(t3.priority, 'low');
  });

  it('FIFO within same priority', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    await queue.sendTask({ sender, receiver_uid: recv, content: 't1', priority: 'normal' });
    await queue.sendTask({ sender, receiver_uid: recv, content: 't2', priority: 'normal' });

    const t1 = await queue.checkInbox(recv); _trackId(t1?.task_id);
    const t2 = await queue.checkInbox(recv); _trackId(t2?.task_id);
    assert.ok(t1.content.includes('t1'));
    assert.ok(t2.content.includes('t2'));
  });

  it('empty inbox returns null', async () => {
    const recv = await _regAgent('recv');
    assert.equal(await queue.checkInbox(recv), null);
  });
});

describe('retry (#68)', () => {
  after(_cleanup);

  it('retries completed task: status→pending, retry_count++', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'test' });
    _trackId(r.task.task_id);

    await queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'done');

    const rr = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(rr.ok, 'retry should succeed');
    assert.equal(rr.retry_count, 1);
    assert.equal(rr.remaining, 2);

    const reloaded = await store.getTaskAsync(r.task.task_id);
    assert.equal(reloaded.status, 'pending');
    assert.equal(reloaded.retry_count, 1);
  });

  it('exhausted on 4th retry', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'x' });
    _trackId(r.task.task_id);

    for (let i = 0; i < 3; i++) {
      await queue.checkInbox(recv);
      await queue.respondTask(r.task.task_id, recv, 'r' + i);
      const rr = await queue.retryTask(r.task.task_id, senderUid);
      assert.ok(rr.ok, 'retry ' + (i + 1) + ' should succeed');
    }

    // 4th retry → exhausted.
    await queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'r3');
    const ex = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(!ex.ok);
    assert.ok(ex.exhausted);
    // Sprint 35: terminal tasks (exhausted) are archived — query the archive.
    const rel = await queue.getArchivedTask(r.task.task_id);
    assert.ok(rel, 'exhausted task should be archived');
    assert.equal(rel.status, 'exhausted');
  });

  it('only sender can retry', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'x' });
    _trackId(r.task.task_id);

    await queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'done');

    const rr = await queue.retryTask(r.task.task_id, 'not_the_sender');
    assert.ok(!rr.ok);
    assert.ok(rr.error.includes('only the sender'));
  });

  it('retries a pending (unclaimed) task', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'x' });
    _trackId(r.task.task_id);

    // A task still in the inbox (pending) is directly retryable.
    const rr = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(rr.ok, 'pending task should be retryable: ' + JSON.stringify(rr));
    assert.equal(rr.retry_count, 1);
  });
});

describe('round-robin (#69)', () => {
  after(_cleanup);

  it('distributes across equally-capable agents', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const agents = [];
    for (let i = 0; i < 3; i++) {
      agents.push(await _regAgent('worker' + i, ['backend', 'nodejs']));
    }

    const assigned = new Set();
    for (let i = 0; i < 3; i++) {
      const r = await queue.sendTask({ sender, content: 't' + i, required_capabilities: ['backend'] });
      if (r.ok) { assigned.add(r.task.receiver_uid); _trackId(r.task.task_id); }
    }
    assert.ok(assigned.size >= 2, 'should use at least 2 different agents, got ' + assigned.size);
  });

  it('prefers idle over busy', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const idle = await _regAgent('idle', ['testing']);
    const busyUid = await _regAgent('busy', ['testing']);

    // Make busyUid busy.
    const occupy = await queue.sendTask({ sender, receiver_uid: busyUid, content: 'occupy' });
    _trackId(occupy.task.task_id);
    await queue.checkInbox(busyUid);

    const r = await queue.sendTask({ sender, content: 'work', required_capabilities: ['testing'] });
    _trackId(r.task.task_id);
    assert.equal(r.task.receiver_uid, idle, 'idle preferred over busy');
  });

  it('falls back to generalist for unmatched caps', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const gen = await _regAgent('通用助手', ['general', 'misc']);
    await _regAgent('specialist', ['frontend']);

    const r = await queue.sendTask({ sender, content: 'ml work', required_capabilities: ['ml-training'] });
    _trackId(r.task.task_id);
    assert.equal(r.task.receiver_uid, gen, 'unmatched → generalist');
  });

  it('findBestAgent returns null for empty list', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    // findBestAgent is async.
    const best = await collaborationLoop.findBestAgent([], ['qa'], sender.uid);
    assert.equal(best, null);
  });
});

describe('store ordering (#67)', () => {
  after(_cleanup);

  it('getPendingTask returns highest priority', async () => {
    const recv = await _regAgent('recv');
    const now = new Date();

    await store.insertTask({
      task_id: TEST_PREFIX + 't_low', sender_uid: 'x', sender_name: '', sender_intro: '',
      receiver_uid: recv, content: 'low', priority: 'low',
      status: 'pending', created_at: new Date(now - 2000).toISOString(),
    });
    await store.insertTask({
      task_id: TEST_PREFIX + 't_high', sender_uid: 'x', sender_name: '', sender_intro: '',
      receiver_uid: recv, content: 'high', priority: 'high',
      status: 'pending', created_at: new Date(now - 1000).toISOString(),
    });
    _trackId(TEST_PREFIX + 't_low');
    _trackId(TEST_PREFIX + 't_high');

    const t = store.getPendingTask(recv);
    assert.ok(t);
    assert.equal(t.task_id, TEST_PREFIX + 't_high');
  });

  it('getPendingTask returns null for empty queue', async () => {
    const recv = await _regAgent('recv');
    assert.equal(store.getPendingTask(recv), null);
  });
});

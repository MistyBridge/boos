// Sprint 8 Waves 5-6 unit tests — #67 priority queue, #68 retry, #69 round-robin.
// Uses real store but with unique test task IDs, cleans up after each test.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/agentBus/store');
const queue = require('../lib/agentBus/queue');
const collaborationLoop = require('../lib/agentBus/collaborationLoop');

const TEST_PREFIX = 'test_w56_';
let _cleanupIds = [];

async function _cleanup() {
  for (const tid of _cleanupIds) {
    try { store.updateTaskStatus(tid, 'cancelled', 'test cleanup'); } catch {}
  }
  _cleanupIds = [];
}

// Register a test agent, track for cleanup.
let _nextAgentIdx = 0;
async function _regAgent(name, caps = [], role = 'worker') {
  const uid = TEST_PREFIX + 'agent_' + (_nextAgentIdx++);
  await store.insertAgent({ uid, name, intro: '', workspace: 'test_w56', role, capabilities: caps });
  return uid;
}

async function _regSender() {
  return _regAgent('sender_' + (_nextAgentIdx), [], 'supervisor');
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

    const t1 = queue.checkInbox(recv); _trackId(t1?.task_id);
    assert.ok(t1, 'should have a task');
    assert.equal(t1.priority, 'high');
    assert.ok(t1.content.includes('high'));

    const t2 = queue.checkInbox(recv); _trackId(t2?.task_id);
    assert.equal(t2.priority, 'normal');

    const t3 = queue.checkInbox(recv); _trackId(t3?.task_id);
    assert.equal(t3.priority, 'low');
  });

  it('FIFO within same priority', async () => {
    const sender = { uid: await _regSender(), name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    await queue.sendTask({ sender, receiver_uid: recv, content: 't1', priority: 'normal' });
    await queue.sendTask({ sender, receiver_uid: recv, content: 't2', priority: 'normal' });

    const t1 = queue.checkInbox(recv); _trackId(t1?.task_id);
    const t2 = queue.checkInbox(recv); _trackId(t2?.task_id);
    assert.ok(t1.content.includes('t1'));
    assert.ok(t2.content.includes('t2'));
  });

  it('empty inbox returns null', async () => {
    const recv = await _regAgent('recv');
    assert.equal(queue.checkInbox(recv), null);
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

    queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'done');

    const rr = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(rr.ok, 'retry should succeed');
    assert.equal(rr.retry_count, 1);
    assert.equal(rr.remaining, 2);

    const reloaded = store.getTask(r.task.task_id);
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
      queue.checkInbox(recv);
      await queue.respondTask(r.task.task_id, recv, 'r' + i);
      const rr = await queue.retryTask(r.task.task_id, senderUid);
      assert.ok(rr.ok, 'retry ' + (i + 1) + ' should succeed');
    }

    // 4th retry → exhausted.
    queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'r3');
    const ex = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(!ex.ok);
    assert.ok(ex.exhausted);
    assert.equal(store.getTask(r.task.task_id).status, 'exhausted');
  });

  it('only sender can retry', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'x' });
    _trackId(r.task.task_id);

    queue.checkInbox(recv);
    await queue.respondTask(r.task.task_id, recv, 'done');

    const rr = await queue.retryTask(r.task.task_id, 'not_the_sender');
    assert.ok(!rr.ok);
    assert.ok(rr.error.includes('only the sender'));
  });

  it('only completed/cancelled retryable', async () => {
    const senderUid = await _regSender();
    const sender = { uid: senderUid, name: 'pm', intro: '', workspace: 'test_w56' };
    const recv = await _regAgent('recv');

    const r = await queue.sendTask({ sender, receiver_uid: recv, content: 'x' });
    _trackId(r.task.task_id);

    const rr = await queue.retryTask(r.task.task_id, senderUid);
    assert.ok(!rr.ok);
    assert.ok(rr.error.includes('only completed or cancelled'));
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
    queue.checkInbox(busyUid);

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
    assert.equal(collaborationLoop.findBestAgent([], ['qa'], sender.uid), null);
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

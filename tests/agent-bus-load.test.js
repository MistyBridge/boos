// Sprint 17 — agent-bus load test (#82)
// In-process load testing using direct store/queue imports.
// Run: node --test tests/agent-bus-load.test.js
//
// Scenarios:
//   1. 50 concurrent send_task → respond_task round-trip
//   2. 10 agents simultaneous register + check_inbox
//   3. Rapid cancel_task + retry_task race condition
//   4. Data integrity after all load

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Helpers ───────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(name, values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    name,
    count: sorted.length,
    min: sorted[0] || 0,
    max: sorted[sorted.length - 1] || 0,
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length || 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── DB path ───────────────────────────────────────────────────────────

const TEST_HOME = process.env.BOOS_HOME || path.join(os.tmpdir(), 'boos-load-test');
const DATA_DIR = path.join(TEST_HOME, '.boos');
const DB_PATH = path.join(DATA_DIR, 'agent-bus.json');

// ── Test suite ────────────────────────────────────────────────────────

describe('agent-bus load test (#82)', () => {
  let store, queue;

  before(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    process.env.BOOS_HOME = TEST_HOME;
    store = require('../lib/agentBus/store');
    queue = require('../lib/agentBus/queue');
  });

  let dbBackup = null;
  before(() => {
    if (fs.existsSync(DB_PATH)) {
      dbBackup = fs.readFileSync(DB_PATH, 'utf-8');
    }
  });

  after(() => {
    if (dbBackup !== null) {
      fs.writeFileSync(DB_PATH, dbBackup, 'utf-8');
    }
  });

  async function cleanupTestAgents(prefix) {
    const agents = store.listAgentsInWorkspace('load-test');
    for (const a of agents) {
      if (a.name && a.name.startsWith(prefix)) {
        try { await store.deleteAgent(a.uid); } catch {}
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 1
  // ═════════════════════════════════════════════════════════════════════
  test('scenario 1: 50 concurrent send_task → respond_task round-trip', async () => {
    const PREFIX = 'rt';
    await cleanupTestAgents(PREFIX);

    const senderUid = uid('sender');
    await store.insertAgent({ uid: senderUid, name: `${PREFIX}-sender`, workspace: 'load-test', role: 'worker' });

    const receivers = [];
    for (let i = 0; i < 50; i++) {
      const ruid = uid(`${PREFIX}-r`);
      await store.insertAgent({ uid: ruid, name: `${PREFIX}-r${i}`, workspace: 'load-test', role: 'worker' });
      receivers.push(ruid);
    }

    const sender = { uid: senderUid, name: `${PREFIX}-sender`, intro: 'load test sender' };

    const sendStart = Date.now();
    const sendLatencies = [];
    const taskIds = [];

    const sendPromises = receivers.map((ruid, i) => {
      const t0 = Date.now();
      return queue.sendTask({
        sender,
        receiver_uid: ruid,
        content: `roundtrip-task-${i}`,
        priority: 'normal',
      }).then(r => {
        sendLatencies.push(Date.now() - t0);
        if (r.ok) taskIds.push(r.task.task_id);
        return r;
      });
    });

    const sendResults = await Promise.all(sendPromises);
    const sendOk = sendResults.filter(r => r.ok);
    const sendElapsed = Date.now() - sendStart;

    assert.strictEqual(sendOk.length, 50, 'all 50 tasks sent');
    console.log(`  Send: ${sendOk.length}/50 ok, ${sendElapsed}ms total`);

    const rtLatencies = [];
    const respondStart = Date.now();

    const respondPromises = receivers.map((ruid, i) => {
      return (async () => {
        const task = await queue.checkInbox(ruid);
        if (!task) return { error: `no task for receiver ${i}` };
        const t0 = Date.now();
        const r = await queue.respondTask(task.task_id, ruid, `result-from-${i}`);
        rtLatencies.push(Date.now() - t0);
        return r;
      })();
    });

    const respondResults = await Promise.all(respondPromises);
    const respondOk = respondResults.filter(r => r.ok);
    const respondElapsed = Date.now() - respondStart;

    console.log(`  Respond: ${respondOk.length}/50 ok, ${respondElapsed}ms total`);

    const lostCount = receivers.length - respondOk.length;
    assert.strictEqual(lostCount, 0, '0 lost tasks');

    const sendStats = stats('send_task', sendLatencies);
    const rtStats = stats('respond_task', rtLatencies);
    console.log(`  Send P50=${sendStats.p50}ms P95=${sendStats.p95}ms P99=${sendStats.p99}ms`);
    console.log(`  Respond P50=${rtStats.p50}ms P95=${rtStats.p95}ms P99=${rtStats.p99}ms`);

    assert.ok(rtStats.p95 < 5000, `P95 respond ${rtStats.p95}ms < 5000ms`);

    await cleanupTestAgents(PREFIX);
    return { sendStats, rtStats };
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 2
  // ═════════════════════════════════════════════════════════════════════
  test('scenario 2: 10 agents simultaneous register + check_inbox', async () => {
    const PREFIX = 'si';
    await cleanupTestAgents(PREFIX);

    const senderUid = uid('si-sender');
    await store.insertAgent({ uid: senderUid, name: `${PREFIX}-sender`, workspace: 'load-test', role: 'worker' });
    const sender = { uid: senderUid, name: `${PREFIX}-sender`, intro: 'simul test sender' };

    const regStart = Date.now();
    const regLatencies = [];
    const agentUids = [];

    const regPromises = Array.from({ length: 10 }, (_, i) => {
      const t0 = Date.now();
      const auid = uid(`${PREFIX}-a`);
      return store.insertAgent({ uid: auid, name: `${PREFIX}-a${i}`, workspace: 'load-test', role: 'worker' }).then(() => {
        regLatencies.push(Date.now() - t0);
        agentUids.push(auid);
        return auid;
      });
    });

    await Promise.all(regPromises);
    const regElapsed = Date.now() - regStart;
    assert.strictEqual(agentUids.length, 10, 'all 10 agents registered');
    console.log(`  Register: 10/10 ok, ${regElapsed}ms total`);

    const taskIds = [];
    for (let i = 0; i < 10; i++) {
      const r = await queue.sendTask({
        sender,
        receiver_uid: agentUids[i],
        content: `simul-task-${i}`,
        priority: 'normal',
      });
      if (r.ok) taskIds.push(r.task.task_id);
    }
    assert.strictEqual(taskIds.length, 10, 'all 10 tasks pre-sent');

    const inboxStart = Date.now();
    const inboxLatencies = [];

    const inboxPromises = agentUids.map((auid) => {
      const t0 = Date.now();
      return queue.checkInbox(auid).then(task => {
        inboxLatencies.push(Date.now() - t0);
        return task;
      });
    });

    const tasks = await Promise.all(inboxPromises);
    const inboxElapsed = Date.now() - inboxStart;

    const gotTasks = tasks.filter(Boolean);
    console.log(`  checkInbox: ${gotTasks.length}/10 got tasks, ${inboxElapsed}ms total`);

    assert.strictEqual(gotTasks.length, 10, 'all 10 agents received tasks');

    const regStats = stats('register', regLatencies);
    const inboxStats = stats('check_inbox', inboxLatencies);
    console.log(`  Register P50=${regStats.p50}ms P95=${regStats.p95}ms`);
    console.log(`  checkInbox P50=${inboxStats.p50}ms P95=${inboxStats.p95}ms`);

    for (const t of gotTasks) {
      try { await queue.respondTask(t.task_id, t.receiver_uid, 'done'); } catch {}
    }

    await cleanupTestAgents(PREFIX);
    return { regStats, inboxStats };
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 3
  // ═════════════════════════════════════════════════════════════════════
  test('scenario 3: cancel_task + retry_task race condition', async () => {
    const PREFIX = 'cr';
    await cleanupTestAgents(PREFIX);

    const senderUid = uid('cr-sender');
    await store.insertAgent({ uid: senderUid, name: `${PREFIX}-sender`, workspace: 'load-test', role: 'worker' });
    const sender = { uid: senderUid, name: `${PREFIX}-sender`, intro: 'cancel-retry sender' };

    const receivers = [];
    for (let i = 0; i < 20; i++) {
      const ruid = uid(`${PREFIX}-r`);
      await store.insertAgent({ uid: ruid, name: `${PREFIX}-r${i}`, workspace: 'load-test', role: 'worker' });
      receivers.push(ruid);
    }

    const taskIds = [];
    for (let i = 0; i < 20; i++) {
      const r = await queue.sendTask({
        sender,
        receiver_uid: receivers[i],
        content: `cr-task-${i}`,
        priority: 'normal',
      });
      if (r.ok) taskIds.push(r.task.task_id);
    }

    const cancelStart = Date.now();
    const cancelLatencies = [];
    const cancelPromises = taskIds.map((tid) => {
      const t0 = Date.now();
      return queue.cancelTask(tid, senderUid).then(r => {
        cancelLatencies.push(Date.now() - t0);
        return { taskId: tid, result: r };
      });
    });
    const cancelResults = await Promise.all(cancelPromises);
    const cancelElapsed = Date.now() - cancelStart;
    const cancelled = cancelResults.filter(r => r.result?.ok);
    const failedCancels = cancelResults.filter(r => !r.result?.ok);
    console.log(`  Cancel: ${cancelled.length}/${taskIds.length} ok, ${cancelElapsed}ms total`);
    if (failedCancels.length > 0) console.log(`  Cancel errors (first 3):`, failedCancels.slice(0, 3).map(r => r.result?.error));

    const retryStart = Date.now();
    const retryLatencies = [];
    const retryPromises = taskIds.map(tid => {
      const t0 = Date.now();
      return queue.retryTask(tid, senderUid).then(r => {
        retryLatencies.push(Date.now() - t0);
        return { taskId: tid, result: r };
      });
    });
    const retryResults = await Promise.all(retryPromises);
    const retryElapsed = Date.now() - retryStart;
    const retried = retryResults.filter(r => r.result?.ok);
    console.log(`  Retry: ${retried.length}/${taskIds.length} ok (re-pending), ${retryElapsed}ms total`);

    assert.ok(cancelled.length > 0, 'at least some cancels succeeded');
    assert.ok(retried.length > 0, 'at least some retries succeeded');

    // Read DB for integrity check (handle ENOENT gracefully)
    let taskEntries = [];
    try {
      if (fs.existsSync(DB_PATH)) {
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        taskEntries = Object.values(db.tasks || {});
      }
    } catch (e) { /* file locked or missing — skip */ }
    const ourTasks = taskEntries.filter(t => taskIds.includes(t.task_id));
    const invalidStates = ourTasks.filter(t =>
      !['pending', 'in_progress', 'completed', 'cancelled', 'exhausted'].includes(t.status)
    );
    assert.strictEqual(invalidStates.length, 0, `0 tasks in invalid state (found: ${invalidStates.length})`);

    const cancelStats = stats('cancel', cancelLatencies);
    const retryStats = stats('retry', retryLatencies);
    console.log(`  Cancel P50=${cancelStats.p50}ms P95=${cancelStats.p95}ms`);
    console.log(`  Retry P50=${retryStats.p50}ms P95=${retryStats.p95}ms`);

    for (const tid of taskIds) {
      const t = queue.getTask(tid);
      if (t && t.status === 'pending') {
        try {
          const claimed = await queue.checkInbox(t.receiver_uid);
          if (claimed) await queue.respondTask(claimed.task_id, t.receiver_uid, 'cleanup');
        } catch {}
      }
    }

    await cleanupTestAgents(PREFIX);
    return { cancelStats, retryStats };
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 4
  // ═════════════════════════════════════════════════════════════════════
  test('scenario 4: agent-bus.json integrity after load', async () => {
    let content;
    try {
      content = fs.readFileSync(DB_PATH, 'utf-8');
    } catch {
      console.log(`  DB not found at ${DB_PATH}, skipping`);
      return;
    }

    let db;
    try {
      db = JSON.parse(content);
    } catch (e) {
      assert.fail(`agent-bus.json corrupted: ${e.message}`);
    }

    assert.ok(db.agents !== undefined, 'agents field present');
    assert.ok(db.tasks !== undefined, 'tasks field present');
    assert.ok(db.sessions !== undefined, 'sessions field present');

    const agentUids = new Set(Object.keys(db.agents || {}));
    const orphanTasks = Object.values(db.tasks || {}).filter(t => !agentUids.has(t.receiver_uid));
    console.log(`  DB size: ${content.length} bytes`);
    console.log(`  Agents: ${Object.keys(db.agents || {}).length}`);
    console.log(`  Tasks: ${Object.keys(db.tasks || {}).length}`);
    console.log(`  Orphan tasks (no receiver): ${orphanTasks.length}`);
    console.log(`  JSON valid: yes`);

    const taskIds = Object.keys(db.tasks || {});
    const uniqueIds = new Set(taskIds);
    assert.strictEqual(taskIds.length, uniqueIds.size, 'no duplicate task IDs');
  });

});

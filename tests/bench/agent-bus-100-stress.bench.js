'use strict';

// Agent-Bus 100-Agent Concurrent Stress Test
//
// Simulates the full agent lifecycle under 100-agent concurrency:
// 1. Register 100 agents
// 2. Task distribution (send_task) across agents
// 3. Task claiming (check_inbox → claim)
// 4. Task response (respond_task)
// 5. Task settlement (settle_task)
//
// Run: node tests/bench/agent-bus-100-stress.bench.js
//
// Prerequisites: set BOOS_HOME to a temp directory for isolation.
//   BOOS_HOME=$(mktemp -d) node tests/bench/agent-bus-100-stress.bench.js

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

// Ensure BOOS_HOME isolation
if (!process.env.BOOS_HOME) {
  process.env.BOOS_HOME = path.join(os.tmpdir(), 'boos-stress-' + Date.now());
}
console.log('[bench] BOOS_HOME =', process.env.BOOS_HOME);

// ── helpers ──────────────────────────────────────────────────────────────

function formatMs(ms) { return ms.toFixed(2) + ' ms'; }

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

function randomDelay(min, max) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// ── agent lifecycle simulation ───────────────────────────────────────────

async function runStressTest(agentCount, tasksPerAgent) {
  // Defer requires until BOOS_HOME is set
  const store = require('../../lib/agentBus/store');
  const queue = require('../../lib/agentBus/queue');
  const inboxStore = require('../../lib/agentBus/inboxStore');

  await inboxStore.ensureDirs();

  const results = {
    registered: 0,
    tasksSent: 0,
    tasksClaimed: 0,
    tasksResponded: 0,
    errors: [],
    registerLatencies: [],
    sendTaskLatencies: [],
    claimLatencies: [],
    respondLatencies: [],
    e2eLatencies: [], // send → respond complete
  };

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Agent-Bus 100-Agent Concurrent Stress Test         ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Agents: %d  │  Tasks/agent: %d                        ║',
    String(agentCount).padStart(3), String(tasksPerAgent).padStart(2));
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Phase 1: Register 100 agents ──────────────────────────────────
  console.log('── Phase 1: Register %d agents ──', agentCount);
  const regStart = Date.now();

  const agentUids = [];
  const registrations = [];
  for (let i = 0; i < agentCount; i++) {
    const uid = 'stress-' + String(i).padStart(4, '0');
    agentUids.push(uid);
    registrations.push((async () => {
      const t0 = Date.now();
      try {
        await store.insertAgent({
          uid,
          name: 'StressAgent-' + i,
          intro: 'Stress test agent ' + i,
          workspace: 'stress-test',
          role: 'worker',
          capabilities: ['stress', 'bench'],
        });
        results.registerLatencies.push(Date.now() - t0);
        results.registered++;
      } catch (e) {
        results.errors.push({ phase: 'register', agent: i, error: e.message });
      }
    })());
  }
  await Promise.all(registrations);
  const regElapsed = Date.now() - regStart;
  const regStat = stats(results.registerLatencies);

  console.log('  Registered:    %d/%d', results.registered, agentCount);
  console.log('  Total time:    %s', formatMs(regElapsed));
  console.log('  Reg avg:       %s', formatMs(regStat.avg));
  console.log('  Reg p95:       %s', formatMs(regStat.p95));
  console.log('');

  // ── Phase 2: Task distribution ────────────────────────────────────
  console.log('── Phase 2: Distribute %d tasks ──', agentCount * tasksPerAgent);
  const sendStart = Date.now();

  const taskMap = new Map(); // uid → [taskIds]
  for (const uid of agentUids) {
    taskMap.set(uid, []);
  }

  const sendOps = [];
  for (let round = 0; round < tasksPerAgent; round++) {
    for (const receiverUid of agentUids) {
      // Sender is a different random agent (or the "PM")
      const senderUid = 'stress-' + String((Math.floor(Math.random() * agentCount))).padStart(4, '0');
      sendOps.push((async () => {
        const t0 = Date.now();
        try {
          const task = await store.insertTask({
            task_id: store.genTaskId(),
            sender_uid: senderUid,
            sender_name: 'Stress-' + senderUid,
            sender_intro: 'sender',
            receiver_uid: receiverUid,
            content: 'stress task round ' + round,
            priority: 'normal',
            status: 'pending',
            created_at: new Date().toISOString(),
          });
          taskMap.get(receiverUid).push(task.task_id);
          results.sendTaskLatencies.push(Date.now() - t0);
          results.tasksSent++;
        } catch (e) {
          results.errors.push({ phase: 'send', receiver: receiverUid, error: e.message });
        }
      })());
    }
  }
  await Promise.all(sendOps);
  const sendElapsed = Date.now() - sendStart;
  const sendStat = stats(results.sendTaskLatencies);

  console.log('  Sent:          %d/%d', results.tasksSent, agentCount * tasksPerAgent);
  console.log('  Total time:    %s', formatMs(sendElapsed));
  console.log('  Send avg:      %s', formatMs(sendStat.avg));
  console.log('  Send p95:      %s', formatMs(sendStat.p95));
  console.log('');

  // ── Phase 3: Claim tasks ──────────────────────────────────────────
  console.log('── Phase 3: Claim tasks (check_inbox simulation) ──');
  const claimStart = Date.now();

  const claimOps = [];
  for (const uid of agentUids) {
    claimOps.push((async () => {
      const t0 = Date.now();
      try {
        const task = await store.claimPendingTaskAsync(uid);
        if (task) {
          results.claimLatencies.push(Date.now() - t0);
          results.tasksClaimed++;
          return task;
        }
      } catch (e) {
        results.errors.push({ phase: 'claim', agent: uid, error: e.message });
      }
      return null;
    })());
  }
  const claimedTasks = (await Promise.all(claimOps)).filter(Boolean);
  const claimElapsed = Date.now() - claimStart;
  const claimStat = stats(results.claimLatencies);

  console.log('  Claimed:       %d', results.tasksClaimed);
  console.log('  Total time:    %s', formatMs(claimElapsed));
  console.log('  Claim avg:     %s', formatMs(claimStat.avg));
  console.log('  Claim p95:     %s', formatMs(claimStat.p95));
  console.log('');

  // ── Phase 4: Respond to tasks ─────────────────────────────────────
  console.log('── Phase 4: Respond to claimed tasks ──');
  const respondStart = Date.now();

  const respondOps = [];
  for (const task of claimedTasks) {
    respondOps.push((async () => {
      const t0 = Date.now();
      try {
        await store.updateTaskStatus(task.task_id, 'completed', 'stress result');
        results.respondLatencies.push(Date.now() - t0);
        results.tasksResponded++;
      } catch (e) {
        results.errors.push({ phase: 'respond', taskId: task.task_id, error: e.message });
      }
    })());
  }
  await Promise.all(respondOps);
  const respondElapsed = Date.now() - respondStart;
  const respondStat = stats(results.respondLatencies);

  console.log('  Responded:     %d', results.tasksResponded);
  console.log('  Total time:    %s', formatMs(respondElapsed));
  console.log('  Respond avg:   %s', formatMs(respondStat.avg));
  console.log('  Respond p95:   %s', formatMs(respondStat.p95));
  console.log('');

  // ── Phase 5: Verify completion ────────────────────────────────────
  console.log('── Phase 5: Verify task completion ──');
  const pendingCounts = [];
  for (const uid of agentUids) {
    const count = await store.countPendingTasks(uid);
    pendingCounts.push(count);
  }
  const totalRemaining = pendingCounts.reduce((a, b) => a + b, 0);
  const successRate = ((results.tasksSent - results.errors.length) / results.tasksSent * 100).toFixed(1);

  console.log('  Remaining tasks: %d', totalRemaining);
  console.log('  Errors:          %d', results.errors.length);
  console.log('  Success rate:    %s%%', successRate);
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────
  const regStat2 = stats(results.registerLatencies);
  const sendStat2 = stats(results.sendTaskLatencies);
  const claimStat2 = stats(results.claimLatencies);
  const respondStat2 = stats(results.respondLatencies);

  console.log('══ Summary ══');
  console.log('  Phase           Count     Avg      P95      P99');
  console.log('  ─────           ─────     ───      ───      ───');
  console.log('  Register        %-6d   %-7s  %-7s  %-7s',
    results.registered, formatMs(regStat2.avg), formatMs(regStat2.p95), formatMs(regStat2.p99));
  console.log('  Send Task       %-6d   %-7s  %-7s  %-7s',
    results.tasksSent, formatMs(sendStat2.avg), formatMs(sendStat2.p95), formatMs(sendStat2.p99));
  console.log('  Claim           %-6d   %-7s  %-7s  %-7s',
    results.tasksClaimed, formatMs(claimStat2.avg), formatMs(claimStat2.p95), formatMs(claimStat2.p99));
  console.log('  Respond         %-6d   %-7s  %-7s  %-7s',
    results.tasksResponded, formatMs(respondStat2.avg), formatMs(respondStat2.p95), formatMs(respondStat2.p99));
  console.log('');

  // ── CI JSON ───────────────────────────────────────────────────────
  const ciResult = {
    benchmark: 'agent-bus-100-stress',
    config: { agents: agentCount, tasksPerAgent, totalTasks: agentCount * tasksPerAgent },
    phaseTimings: {
      registerMs: regElapsed,
      sendTaskMs: sendElapsed,
      claimMs: claimElapsed,
      respondMs: respondElapsed,
      totalMs: Date.now() - regStart,
    },
    phaseStats: {
      register: regStat2,
      sendTask: sendStat2,
      claim: claimStat2,
      respond: respondStat2,
    },
    outcomes: {
      registered: results.registered,
      tasksSent: results.tasksSent,
      tasksClaimed: results.tasksClaimed,
      tasksResponded: results.tasksResponded,
      errors: results.errors.length,
      successRate: parseFloat(successRate),
    },
  };

  console.log('── CI JSON ──');
  console.log(JSON.stringify(ciResult, null, 2));

  // Cleanup
  try {
    await fs.rm(process.env.BOOS_HOME, { recursive: true, force: true });
  } catch {}
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  await runStressTest(100, 5); // 100 agents × 5 tasks each = 500 tasks
}

main().catch((e) => {
  console.error('Stress test failed:', e);
  process.exit(1);
});

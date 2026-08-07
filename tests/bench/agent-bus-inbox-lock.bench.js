'use strict';

// Agent-Bus Inbox File Lock Performance Benchmark
//
// Measures per-uid lock vs shared lock throughput under concurrent writes.
// Each agent writes to its own inbox file in the per-uid case; all agents
// write to a single shared file in the shared-lock case.
//
// Run: node tests/bench/agent-bus-inbox-lock.bench.js

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

// ── helpers ──────────────────────────────────────────────────────────────

function formatMs(ms) { return ms.toFixed(2) + ' ms'; }
function formatOps(ops, elapsedMs) {
  const perSec = (ops / (elapsedMs / 1000)).toFixed(1);
  return `${perSec} ops/s`;
}

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

// ── per-uid lock benchmark ───────────────────────────────────────────────
//
// Each agent writes to its own file.  withFileLock serializes writes to the
// SAME file, so 100 agents writing to 100 different files have zero lock
// contention — only the OS filesystem serializes the actual I/O.

async function benchPerUidLock(agentCount, tasksPerAgent) {
  const tmpDir = path.join(os.tmpdir(), 'boos-bench-peruid-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });

  const { atomicWriteJson } = require('../../lib/atomicJson');
  const latencies = [];

  const start = Date.now();

  // All agents write concurrently — each to their own file.
  const writes = [];
  for (let a = 0; a < agentCount; a++) {
    const uid = 'agent-' + String(a).padStart(4, '0');
    const filePath = path.join(tmpDir, uid + '.json');
    writes.push((async () => {
      for (let t = 0; t < tasksPerAgent; t++) {
        const t0 = Date.now();
        await atomicWriteJson(filePath, {
          pending: [{ task_id: 'task_' + t, content: 'bench task ' + t }],
          in_progress: [],
        });
        latencies.push(Date.now() - t0);
      }
    })());
  }
  await Promise.all(writes);

  const elapsed = Date.now() - start;
  const totalOps = agentCount * tasksPerAgent;

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });

  return { elapsed, totalOps, latencies };
}

// ── shared lock benchmark ────────────────────────────────────────────────
//
// All agents write to a single shared file.  withFileLock serializes writes
// so only one agent can mutate at a time — measuring lock contention.

async function benchSharedLock(agentCount, tasksPerAgent) {
  const tmpDir = path.join(os.tmpdir(), 'boos-bench-shared-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });

  const { atomicWriteJson } = require('../../lib/atomicJson');
  const sharedFile = path.join(tmpDir, 'shared-inbox.json');

  // Initialize with empty structure
  const initData = {};
  for (let a = 0; a < agentCount; a++) {
    const uid = 'agent-' + String(a).padStart(4, '0');
    initData[uid] = { pending: [], in_progress: [] };
  }
  await atomicWriteJson(sharedFile, initData);

  const latencies = [];

  const start = Date.now();

  const writes = [];
  for (let a = 0; a < agentCount; a++) {
    const uid = 'agent-' + String(a).padStart(4, '0');
    writes.push((async () => {
      for (let t = 0; t < tasksPerAgent; t++) {
        const t0 = Date.now();
        // Simulate load→mutate→save cycle through the shared lock
        const { withFileLock } = require('../../lib/atomicJson');
        try {
          await withFileLock(sharedFile, async () => {
            // load
            const raw = await fs.readFile(sharedFile, 'utf-8');
            const data = JSON.parse(raw);
            // mutate
            if (!data[uid]) data[uid] = { pending: [], in_progress: [] };
            data[uid].pending.push({ task_id: uid + '_' + t, content: 'task' });
            // save
            const json = JSON.stringify(data);
            await fs.writeFile(sharedFile, json, 'utf-8');
          }, 10000);
        } catch (e) {
          latencies.push(Date.now() - t0);
          throw e;
        }
        latencies.push(Date.now() - t0);
      }
    })());
  }
  await Promise.all(writes);

  const elapsed = Date.now() - start;
  const totalOps = agentCount * tasksPerAgent;

  await fs.rm(tmpDir, { recursive: true, force: true });

  return { elapsed, totalOps, latencies };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const AGENTS = 100;
  const TASKS = 10; // 100 agents × 10 tasks each = 1000 writes

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Agent-Bus Inbox File Lock Performance Benchmark    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Agents: %d  │  Tasks/agent: %d  │  Total writes: %d ║',
    String(AGENTS).padStart(3), String(TASKS).padStart(2), String(AGENTS * TASKS).padStart(4));
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Per-UID Lock ──────────────────────────────────────────────────
  console.log('── Per-UID Lock (each agent writes to own file) ──');
  const perUid = await benchPerUidLock(AGENTS, TASKS);
  const perUidStat = stats(perUid.latencies);

  console.log('  Total time:    %s', formatMs(perUid.elapsed));
  console.log('  Throughput:    %s', formatOps(perUid.totalOps, perUid.elapsed));
  console.log('  Latency min:   %s', formatMs(perUidStat.min));
  console.log('  Latency avg:   %s', formatMs(perUidStat.avg));
  console.log('  Latency p50:   %s', formatMs(perUidStat.p50));
  console.log('  Latency p95:   %s', formatMs(perUidStat.p95));
  console.log('  Latency p99:   %s', formatMs(perUidStat.p99));
  console.log('  Latency max:   %s', formatMs(perUidStat.max));
  console.log('');

  // ── Shared Lock ───────────────────────────────────────────────────
  console.log('── Shared Lock (all agents write to one file) ──');
  const shared = await benchSharedLock(AGENTS, TASKS);
  const sharedStat = stats(shared.latencies);

  console.log('  Total time:    %s', formatMs(shared.elapsed));
  console.log('  Throughput:    %s', formatOps(shared.totalOps, shared.elapsed));
  console.log('  Latency min:   %s', formatMs(sharedStat.min));
  console.log('  Latency avg:   %s', formatMs(sharedStat.avg));
  console.log('  Latency p50:   %s', formatMs(sharedStat.p50));
  console.log('  Latency p95:   %s', formatMs(sharedStat.p95));
  console.log('  Latency p99:   %s', formatMs(sharedStat.p99));
  console.log('  Latency max:   %s', formatMs(sharedStat.max));
  console.log('');

  // ── Comparison ────────────────────────────────────────────────────
  const speedup = (perUid.elapsed > 0)
    ? (shared.elapsed / perUid.elapsed).toFixed(2) + 'x'
    : 'N/A';
  const lockContentionRatio = perUidStat.avg > 0
    ? (sharedStat.avg / perUidStat.avg).toFixed(1) + 'x'
    : 'N/A';

  console.log('══ Comparison ══');
  console.log('  Per-UID is %s faster than shared (wall-clock)', speedup);
  console.log('  Avg latency: per-uid=%s  shared=%s  ratio=%s',
    formatMs(perUidStat.avg), formatMs(sharedStat.avg), lockContentionRatio);
  console.log('  P99 latency:  per-uid=%s  shared=%s',
    formatMs(perUidStat.p99), formatMs(sharedStat.p99));
  console.log('');

  // ── JSON output for CI ────────────────────────────────────────────
  const result = {
    benchmark: 'agent-bus-inbox-lock',
    config: { agents: AGENTS, tasksPerAgent: TASKS, totalWrites: AGENTS * TASKS },
    perUid: { elapsedMs: perUid.elapsed, ...perUidStat },
    shared: { elapsedMs: shared.elapsed, ...sharedStat },
    comparison: {
      wallClockSpeedup: perUid.elapsed > 0 ? shared.elapsed / perUid.elapsed : null,
      avgLatencyRatio: perUidStat.avg > 0 ? sharedStat.avg / perUidStat.avg : null,
    },
  };

  console.log('── CI JSON ──');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});

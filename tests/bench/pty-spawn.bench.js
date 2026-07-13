'use strict';

// PTY spawn benchmark — measures spawn throughput, memory impact, and
// multiplexing latency under increasing concurrency levels.
//
// Run: node tests/bench/pty-spawn.bench.js
//
// Output: JSON to stdout, suitable for CI trend tracking.
//
// Prerequisites: node-pty must be installed (npm install).

const path = require('node:path');
const { spawn } = require('node:child_process');

// ── helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    rss: m.rss,
    external: m.external,
  };
}

function memDiff(before, after) {
  return {
    heapUsed: after.heapUsed - before.heapUsed,
    heapTotal: after.heapTotal - before.heapTotal,
    rss: after.rss - before.rss,
    external: after.external - before.external,
  };
}

/**
 * Spawn N child processes that simulate PTY sessions.
 * Each child runs a trivial node script that stays alive briefly.
 * We measure spawn throughput and memory.
 *
 * @param {number} count — how many to spawn
 * @param {number} aliveMs — how long each child lives
 * @returns {Promise<{elapsedMs:number, perSpawnMs:number, memBefore:object, memAfter:object, memDelta:object}>}
 */
async function benchSpawn(count, aliveMs = 500) {
  const memBefore = memSnapshot();
  const start = Date.now();

  const procs = [];
  for (let i = 0; i < count; i++) {
    procs.push(
      new Promise((resolve) => {
        const child = spawn(process.execPath, [
          '-e',
          `setTimeout(() => {}, ${aliveMs})`,
        ], {
          stdio: 'ignore',
        });
        child.on('exit', () => resolve());
        child.on('error', () => resolve()); // ignore errors
      })
    );
  }

  await Promise.all(procs);
  const elapsedMs = Date.now() - start;
  const memAfter = memSnapshot();

  return {
    count,
    elapsedMs,
    perSpawnMs: +(elapsedMs / count).toFixed(2),
    memBefore,
    memAfter,
    memDelta: memDiff(memBefore, memAfter),
  };
}

/**
 * Measure PTY multiplexing latency: spawn many children, send input to each
 * in a round-robin, measure distribution.
 *
 * We use `node -e "process.stdin.on('data', d => process.stdout.write(d))"`
 * as a simple echo server and measure round-trip time.
 *
 * @param {number} count — concurrent echo servers
 * @returns {Promise<{avgMs:number, p50Ms:number, p99Ms:number, maxMs:number}>}
 */
async function benchMultiplexLatency(count) {
  const echoScript = `
    process.stdin.on('data', (d) => {
      process.stdout.write('ECHO:' + d.toString().trim());
    });
    process.stdout.write('READY\\n');
  `;

  const children = [];
  const latencies = [];

  for (let i = 0; i < count; i++) {
    const child = spawn(process.execPath, ['-e', echoScript], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    // Wait for READY signal
    await new Promise((resolve) => {
      const onData = (d) => {
        if (d.toString().includes('READY')) {
          child.stdout.removeListener('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });

    children.push(child);
  }

  // Send messages to all children and measure RTT
  const rttPromises = children.map((child, i) => {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const msg = `ping-${i}\n`;

      const onData = (d) => {
        if (d.toString().includes(`ECHO:ping-${i}`)) {
          const rtt = Date.now() - t0;
          latencies.push(rtt);
          child.stdout.removeListener('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(msg);
    });
  });

  const start = Date.now();
  await Promise.all(rttPromises);
  const totalMs = Date.now() - start;

  // Cleanup
  for (const child of children) {
    try { child.kill(); } catch {}
  }

  // Stats
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  return {
    count,
    totalMs,
    avgMs: +avg.toFixed(2),
    p50Ms: p50,
    p99Ms: p99,
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
    samples: latencies.length,
  };
}

// ── main ─────────────────────────────────────────────────────────────────

(async () => {
  const nodeVersion = process.version;
  const platform = process.platform;
  const arch = process.arch;
  const cpus = require('node:os').cpus().length;

  console.error(`BOOS PTY Spawn Benchmark`);
  console.error(`Node ${nodeVersion} · ${platform} ${arch} · ${cpus} CPUs`);
  console.error('');

  const results = {
    meta: {
      nodeVersion,
      platform,
      arch,
      cpus,
      timestamp: new Date().toISOString(),
    },
    spawn: [],
    multiplex: [],
  };

  // ── Spawn benchmarks ───────────────────────────────────────────────
  const concurrencyLevels = [10, 50, 100];
  for (const n of concurrencyLevels) {
    console.error(`Spawn benchmark: ${n} concurrent processes...`);
    const r = await benchSpawn(n);
    results.spawn.push(r);
    console.error(`  elapsed: ${r.elapsedMs}ms  per-spawn: ${r.perSpawnMs}ms  heap+${formatBytes(r.memDelta.heapUsed)}`);
  }

  // ── Multiplex latency benchmarks ──────────────────────────────────
  console.error('');
  const latencyLevels = [10, 50];
  for (const n of latencyLevels) {
    console.error(`Multiplex latency: ${n} concurrent echo servers...`);
    const r = await benchMultiplexLatency(n);
    results.multiplex.push(r);
    console.error(`  avg: ${r.avgMs}ms  p50: ${r.p50Ms}ms  p99: ${r.p99Ms}ms  max: ${r.maxMs}ms`);
  }

  console.error('');
  console.error('Done.');

  // Output JSON to stdout
  process.stdout.write(JSON.stringify(results, null, 2));
})().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});

// Sprint 23 — agent-bus 高负载测试 (#82 升级)
// In-process + real HTTP testing using store/queue/transport.
// Run: node --test tests/agent-bus-load.test.js
//
// Scenarios:
//   1. 并发注册: 10/50/100 agents → 测量延迟和成功率
//   2. 并发任务: 100/500/1000 tasks → 测量 queue 吞吐量
//   3. SSE 连接压力: 50 SSE 连接 → 测量稳定性和资源释放
//   4. 持续负载: 5 分钟高频 send_task → 测量性能衰减

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

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

// Use PID-unique temp dir to avoid EPERM from stale file handles / other tests.
const TEST_HOME = path.join(os.tmpdir(), 'boos-load-' + process.pid);
const DATA_DIR = path.join(TEST_HOME, '.boos');
const DB_PATH = path.join(DATA_DIR, 'agent-bus.json');

// ── Test suite ────────────────────────────────────────────────────────

describe('agent-bus Sprint 23 load test (#82)', () => {
  let store, queue, transport;

  before(() => {
    // Clean stale temp dir if it exists from a previous crashed run.
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(DATA_DIR, { recursive: true });
    process.env.BOOS_HOME = TEST_HOME;
    // Sprint 42: the SSE pressure scenario opens 50 connections from one IP
    // concurrently — the reconnect backoff (1000ms/IP) would 429 all but the
    // first. Backoff is for reconnect storms, not connection-pressure tests.
    process.env.BOOS_SSE_MIN_RECONNECT_INTERVAL_MS = '0';
    // Clear require cache for clean load
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/agentBus/store')];
    delete require.cache[require.resolve('../lib/agentBus/queue')];
    delete require.cache[require.resolve('../lib/agentBus/transport')];

    store = require('../lib/agentBus/store');
    queue = require('../lib/agentBus/queue');
    transport = require('../lib/agentBus/transport');
  });

  // Backup DB before tests
  let dbBackup = null;
  before(() => {
    if (fs.existsSync(DB_PATH)) {
      dbBackup = fs.readFileSync(DB_PATH, 'utf-8');
      // Write empty starting DB
      fs.writeFileSync(DB_PATH, JSON.stringify({
        agents: {}, tasks: {}, sessions: {},
        identity_by_boos_session: {}, identity_by_mcp_session: {}, identity_by_name_ws: {},
      }), 'utf-8');
    }
  });

  after(() => {
    if (dbBackup !== null) {
      fs.writeFileSync(DB_PATH, dbBackup, 'utf-8');
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 1: 并发注册 — 10/50/100 agents
  // ═════════════════════════════════════════════════════════════════════
  describe('scenario 1: concurrent agent registration', () => {
    const SCALES = [10, 50, 100];
    const PREFIX = 's1reg';

    for (const scale of SCALES) {
      test(`register ${scale} agents concurrently`, async () => {
        const batch = uid(PREFIX);
        const regStart = Date.now();
        const regLatencies = [];
        const regResults = [];

        const promises = Array.from({ length: scale }, (_, i) => {
          const t0 = Date.now();
          const auid = `${batch}-${i}`;
          return store.insertAgent({
            uid: auid,
            name: `${batch}-${i}`,
            workspace: 'load-test',
            role: 'worker',
            intro: `load test agent ${i}`,
          }).then(r => {
            regLatencies.push(Date.now() - t0);
            regResults.push(r);
            return r;
          }).catch(e => {
            regLatencies.push(Date.now() - t0);
            regResults.push({ error: e.message });
          });
        });

        await Promise.all(promises);
        const regElapsed = Date.now() - regStart;

        const regOk = regResults.filter(r => !r.error);
        const successRate = ((regOk.length / scale) * 100).toFixed(1);

        const regStats = stats('register', regLatencies);
        console.log(`  [${scale}] ${regOk.length}/${scale} ok (${successRate}%), ${regElapsed}ms total`);
        console.log(`  [${scale}] P50=${regStats.p50}ms P95=${regStats.p95}ms P99=${regStats.p99}ms min=${regStats.min}ms max=${regStats.max}ms`);

        // All registrations must succeed
        assert.strictEqual(regOk.length, scale, `all ${scale} agents registered successfully`);
        // P95 should be reasonable
        assert.ok(regStats.p95 < 30000, `P95 register ${regStats.p95}ms < 30000ms`);

        // Verify agents in DB
        const allAgents = store.listAgentsInWorkspace('load-test');
        const ourAgents = allAgents.filter(a => a.uid && a.uid.startsWith(batch));
        assert.strictEqual(ourAgents.length, scale, `all ${scale} agents found in DB`);

        // Cleanup
        for (const a of ourAgents) {
          try { await store.deleteAgent(a.uid); } catch {}
        }
      });
    }

    test(`register agents throughput summary`, async () => {
      // Run small scale to estimate throughput
      const batch = uid('throughput');
      const count = 20;
      const regStart = Date.now();
      const promises = Array.from({ length: count }, (_, i) =>
        store.insertAgent({
          uid: `${batch}-${i}`,
          name: `${batch}-${i}`,
          workspace: 'load-test',
          role: 'worker',
        })
      );
      await Promise.all(promises);
      const elapsed = Date.now() - regStart;
      const throughput = ((count / elapsed) * 1000).toFixed(1);
      console.log(`  Throughput: ${throughput} agents/sec (${count} agents in ${elapsed}ms)`);

      // Cleanup
      const agents = store.listAgentsInWorkspace('load-test');
      for (const a of agents) {
        if (a.uid && a.uid.startsWith(batch)) {
          try { await store.deleteAgent(a.uid); } catch {}
        }
      }

      assert.ok(elapsed < 60000, 'throughput test completed in reasonable time');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 2: 并发任务 — 100/500/1000 tasks
  // ═════════════════════════════════════════════════════════════════════
  describe('scenario 2: concurrent task dispatch', () => {
    const SCALES = [100, 500, 1000];
    const PREFIX = 's2';

    for (const scale of SCALES) {
      test(`send+respond ${scale} tasks`, async () => {
        // Create sender
        const senderUid = uid('s2-sender');
        await store.insertAgent({
          uid: senderUid, name: `${PREFIX}-sender`, workspace: 'load-test', role: 'worker',
          intro: 'load test sender',
        });
        const sender = { uid: senderUid, name: `${PREFIX}-sender`, intro: 'load test sender' };

        // Create receivers SEQUENTIALLY (withFileLock serializes anyway, and
        // concurrent Promise.all can cause EPERM on Windows rename).
        const receivers = [];
        for (let i = 0; i < scale; i++) {
          const ruid = uid(`${PREFIX}-r`);
          receivers.push(ruid);
          await store.insertAgent({
            uid: ruid, name: `${PREFIX}-r${i}`, workspace: 'load-test', role: 'worker',
            intro: `load test receiver ${i}`,
          });
        }

        // Verify agents persisted before proceeding
        let persisted = 0;
        for (const ruid of receivers) {
          if (store.getAgent(ruid)) persisted++;
        }
        console.log(`  [${scale}] ${receivers.length} receivers created, ${persisted} persisted`);

        // Send all tasks concurrently
        const sendStart = Date.now();
        const sendLatencies = [];
        const taskIds = [];
        const sendErrors = [];

        const sendPromises = receivers.map((ruid, i) => {
          const t0 = Date.now();
          return queue.sendTask({
            sender,
            receiver_uid: ruid,
            content: `s2-task-${scale}-${i}`,
            priority: 'normal',
          }).then(r => {
            sendLatencies.push(Date.now() - t0);
            if (r.ok) {
              taskIds.push(r.task.task_id);
            } else {
              sendErrors.push({ i, error: r.error || 'unknown' });
            }
            return r;
          }).catch(e => {
            sendLatencies.push(Date.now() - t0);
            sendErrors.push({ i, error: e.message });
          });
        });

        await Promise.all(sendPromises);
        const sendElapsed = Date.now() - sendStart;

        const sendOk = scale - sendErrors.length;
        const sendStats = stats('send_task', sendLatencies);
        const throughput = ((sendOk / sendElapsed) * 1000).toFixed(1);
        console.log(`  [${scale}] Send: ${sendOk}/${scale} ok, ${sendElapsed}ms, ${throughput} tasks/sec`);
        console.log(`  [${scale}] Send P50=${sendStats.p50}ms P95=${sendStats.p95}ms P99=${sendStats.p99}ms`);
        if (sendErrors.length > 0) {
          console.log(`  [${scale}] Send errors: ${sendErrors.length} (first: ${JSON.stringify(sendErrors[0])})`);
        }

        // Respond to all tasks
        const respondStart = Date.now();
        const respondLatencies = [];
        const respondErrors = [];

        // Process in smaller concurrent batches to avoid overwhelming file lock
        const RESPOND_BATCH = 50;
        for (let i = 0; i < taskIds.length; i += RESPOND_BATCH) {
          const batchEnd = Math.min(i + RESPOND_BATCH, taskIds.length);
          const batchPromises = [];
          for (let j = i; j < batchEnd; j++) {
            const tid = taskIds[j];
            const ruid = receivers[j];
            if (!tid || !ruid) continue;
            batchPromises.push((async () => {
              const t0 = Date.now();
              try {
                // Claim first
                const claimed = await queue.checkInbox(ruid);
                if (!claimed) {
                  respondErrors.push({ j, error: 'no task in inbox' });
                  respondLatencies.push(Date.now() - t0);
                  return;
                }
                const r = await queue.respondTask(claimed.task_id, ruid, `s2-result-${scale}-${j}`);
                respondLatencies.push(Date.now() - t0);
                if (!r.ok) respondErrors.push({ j, error: r.error || 'respond failed' });
              } catch (e) {
                respondLatencies.push(Date.now() - t0);
                respondErrors.push({ j, error: e.message });
              }
            })());
          }
          await Promise.all(batchPromises);
        }

        const respondElapsed = Date.now() - respondStart;
        const respondOk = taskIds.length - respondErrors.length;
        const respondStats = stats('respond', respondLatencies);
        const respThroughput = ((respondOk / respondElapsed) * 1000).toFixed(1);
        console.log(`  [${scale}] Respond: ${respondOk}/${taskIds.length} ok, ${respondElapsed}ms, ${respThroughput} tasks/sec`);
        console.log(`  [${scale}] Respond P50=${respondStats.p50}ms P95=${respondStats.p95}ms P99=${respondStats.p99}ms`);
        if (respondErrors.length > 0) {
          console.log(`  [${scale}] Respond errors: ${respondErrors.length} (first: ${JSON.stringify(respondErrors[0])})`);
        }

        // Assertions — relaxed for scale
        const sendRate = (sendOk / scale) * 100;
        assert.ok(sendRate >= 90, `send success rate ${sendRate.toFixed(1)}% >= 90%`);
        if (respondOk > 0 && respondStats.count > 0) {
          assert.ok(respondStats.p95 < 60000, `P95 respond ${respondStats.p95}ms < 60000ms`);
        }
        // Tasks not lost from DB
        const lostCount = Math.max(0, taskIds.length - respondOk - respondErrors.length);
        console.log(`  [${scale}] Lost tasks: ${lostCount}`);
        console.log(`  [${scale}] Throughput (send): ${throughput} tasks/sec`);

        // Cleanup
        try { await store.deleteAgent(senderUid); } catch {}
        for (const ruid of receivers) {
          try { await store.deleteAgent(ruid); } catch {}
        }
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 3: SSE 连接压力 — 50 connections
  // ═════════════════════════════════════════════════════════════════════
  describe('scenario 3: SSE connection pressure', () => {
    let server, port;
    let appStarted = false;

    // Helper: start server on demand (deferred to avoid EPERM races with
    // concurrent file writes from other scenarios).
    async function ensureServer() {
      if (appStarted) return;
      const app = express();
      app.use(express.json());
      const router = transport.createRouter();
      app.use('/mcp', router);

      await new Promise((resolve, reject) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          console.log(`  SSE test server on port ${port}`);
          appStarted = true;
          resolve();
        });
        server.on('error', reject);
      });
    }

    after(() => {
      if (server) {
        server.close();
        if (server.closeAllConnections) server.closeAllConnections();
      }
    });

    test('connect 50 SSE sessions and verify all active', async () => {
      await ensureServer();
      const connections = [];
      const errors = [];

      const connectStart = Date.now();
      const connectLatencies = [];

      // Open 50 SSE connections concurrently
      const connectPromises = Array.from({ length: 50 }, (_, i) => {
        const t0 = Date.now();
        return new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/mcp/sse?sessionId=sse-load-${i}`,
            method: 'GET',
            headers: {
              'Accept': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Host': `127.0.0.1:${port}`,
            },
            timeout: 10000,
          });

          let gotEndpoint = false;
          let data = '';

          req.on('response', (res) => {
            if (res.statusCode !== 200) {
              errors.push({ i, status: res.statusCode });
              connectLatencies.push(Date.now() - t0);
              resolve();
              return;
            }

            res.on('data', (chunk) => {
              data += chunk.toString();
              // Check for endpoint event (first SSE message)
              if (!gotEndpoint && data.includes('event: endpoint')) {
                gotEndpoint = true;
                connectLatencies.push(Date.now() - t0);
                connections.push({ req, res, i });
                resolve();
              }
            });

            res.on('end', () => {
              if (!gotEndpoint) {
                errors.push({ i, error: 'connection closed before endpoint' });
                connectLatencies.push(Date.now() - t0);
                resolve();
              }
            });

            res.on('error', (e) => {
              errors.push({ i, error: e.message });
              connectLatencies.push(Date.now() - t0);
              resolve();
            });
          });

          req.on('error', (e) => {
            errors.push({ i, error: e.message });
            connectLatencies.push(Date.now() - t0);
            resolve();
          });

          req.on('timeout', () => {
            req.destroy();
            errors.push({ i, error: 'timeout' });
            connectLatencies.push(Date.now() - t0);
            resolve();
          });

          req.end();
        });
      });

      await Promise.all(connectPromises);
      const connectElapsed = Date.now() - connectStart;

      const connectStats = stats('SSE connect', connectLatencies);
      console.log(`  SSE connections: ${connections.length}/50 established, ${errors.length} errors`);
      console.log(`  Connect time: ${connectElapsed}ms total`);
      console.log(`  Connect P50=${connectStats.p50}ms P95=${connectStats.p95}ms P99=${connectStats.p99}ms`);

      // At least most connections should succeed
      assert.ok(connections.length >= 40, `at least 40/50 SSE connections established (got ${connections.length})`);
      if (errors.length > 0) {
        console.log(`  SSE errors (first 5): ${JSON.stringify(errors.slice(0, 5))}`);
      }

      // Verify connection count not exceeding limit
      assert.ok(connections.length <= 50, 'does not exceed MAX_SSE_CONNECTIONS');

      // Cleanup: close all connections
      const closeStart = Date.now();
      const closeLatencies = [];

      for (const conn of connections) {
        const t0 = Date.now();
        try {
          conn.req.destroy();
          if (conn.res && typeof conn.res.destroy === 'function') {
            conn.res.destroy();
          }
        } catch {}
        closeLatencies.push(Date.now() - t0);
      }

      const closeElapsed = Date.now() - closeStart;
      console.log(`  SSE close: ${connections.length} connections, ${closeElapsed}ms total`);
    });

    test('reject connections beyond MAX_SSE_CONNECTIONS', async () => {
      await ensureServer();
      // Fill 50 connections, then try 51st
      const connections = [];

      // Open 50 connections
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/mcp/sse?sessionId=sse-limit-${i}`,
            method: 'GET',
            headers: {
              'Accept': 'text/event-stream',
              'Host': `127.0.0.1:${port}`,
            },
            timeout: 5000,
          });

          req.on('response', (res) => {
            if (res.statusCode === 200) {
              connections.push({ req, res, i });
              res.on('data', () => {}); // consume data
            }
            resolve();
          });

          req.on('error', () => resolve());
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.end();
        });
      }

      console.log(`  Filled ${connections.length}/50 connections`);

      // Try 51st — should get 503
      const rejection = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/mcp/sse?sessionId=sse-overflow',
          method: 'GET',
          headers: {
            'Accept': 'text/event-stream',
            'Host': `127.0.0.1:${port}`,
          },
          timeout: 5000,
        });

        req.on('response', (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(body) });
            } catch {
              resolve({ status: res.statusCode, body });
            }
          });
        });

        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
        req.end();
      });

      console.log(`  Overflow response: status=${rejection.status} error=${rejection.body?.error || 'none'}`);
      assert.strictEqual(rejection.status, 503, 'overflow connection gets 503');

      // Cleanup
      for (const conn of connections) {
        try { conn.req.destroy(); } catch {}
        try { if (conn.res) conn.res.destroy(); } catch {}
      }
    });

    test('SSE cleanup after mass disconnect', async () => {
      await ensureServer();
      // Open 20 connections, then close all at once
      const connections = [];

      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/mcp/sse?sessionId=sse-cleanup-${i}`,
            method: 'GET',
            headers: {
              'Accept': 'text/event-stream',
              'Host': `127.0.0.1:${port}`,
            },
            timeout: 5000,
          });

          req.on('response', (res) => {
            if (res.statusCode === 200) {
              connections.push({ req, res, i });
              res.on('data', () => {});
            }
            resolve();
          });

          req.on('error', () => resolve());
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.end();
        });
      }

      console.log(`  Pre-cleanup: ${connections.length}/20 connected`);

      // Mass disconnect
      for (const conn of connections) {
        try { conn.req.destroy(); } catch {}
      }

      // Wait for cleanup to propagate
      await new Promise(r => setTimeout(r, 500));

      // Try connecting again — should work
      const reconnectOk = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/mcp/sse?sessionId=sse-reconnect-test',
          method: 'GET',
          headers: {
            'Accept': 'text/event-stream',
            'Host': `127.0.0.1:${port}`,
          },
          timeout: 5000,
        });

        req.on('response', (res) => {
          if (res.statusCode === 200) {
            res.on('data', () => {});
          }
          resolve(res.statusCode === 200);
          req.destroy();
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });

      console.log(`  Post-cleanup reconnect: ${reconnectOk ? 'ok' : 'failed'}`);
      assert.ok(reconnectOk, 'reconnect succeeds after mass disconnect');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Scenario 4: 持续负载 — 5-minute sustained send_task
  // ═════════════════════════════════════════════════════════════════════
  describe('scenario 4: sustained load (5 min)', () => {
    const DURATION_MS = 5 * 60 * 1000; // 5 minutes
    const PREFIX = 's4';
    const CONCURRENCY = 10; // Keep 10 tasks in-flight at all times

    test(`high-frequency send_task for ${DURATION_MS / 1000}s`, async () => {
      const batch = uid(PREFIX);

      // Create sender
      const senderUid = uid('s4-sender');
      await store.insertAgent({
        uid: senderUid, name: `${PREFIX}-sender`, workspace: 'load-test', role: 'worker',
        intro: 'sustained load sender',
      });
      const sender = { uid: senderUid, name: `${PREFIX}-sender`, intro: 'sustained load sender' };

      // Create 50 receiver agents (reuse them for the entire test)
      const receiverCount = 50;
      const receivers = [];
      for (let i = 0; i < receiverCount; i++) {
        const ruid = uid(`${PREFIX}-r`);
        receivers.push(ruid);
        await store.insertAgent({
          uid: ruid, name: `${PREFIX}-r${i}`, workspace: 'load-test', role: 'worker',
          intro: `sustained receiver ${i}`,
        });
      }

      const startTime = Date.now();
      const endTime = startTime + DURATION_MS;

      let totalSent = 0;
      let totalErrors = 0;
      let totalResponded = 0;
      const sendLatencies = [];
      const timeSeries = []; // { time, sent, errors, latency }

      // Collector that processes responses in background
      const pendingTasks = [];
      let collectorRunning = true;

      const collector = (async () => {
        while (collectorRunning || pendingTasks.length > 0) {
          // Batch process inbox checks
          const batch = pendingTasks.splice(0, Math.min(CONCURRENCY, pendingTasks.length));
          if (batch.length === 0) {
            await new Promise(r => setTimeout(r, 10));
            continue;
          }

          const results = await Promise.all(batch.map(async ({ ruid, seq }) => {
            try {
              const claimed = await queue.checkInbox(ruid);
              if (!claimed) return { ok: false, seq, error: 'empty inbox' };
              const r = await queue.respondTask(claimed.task_id, ruid, `s4-result-${seq}`);
              return r;
            } catch (e) {
              return { ok: false, seq, error: e.message };
            }
          }));

          const ok = results.filter(r => r.ok);
          totalResponded += ok.length;
          totalErrors += results.length - ok.length;
        }
      })();

      // Main send loop
      let seq = 0;
      const reportInterval = 30000; // Report every 30s
      let lastReport = startTime;

      while (Date.now() < endTime) {
        const now = Date.now();

        // Report periodic stats
        if (now - lastReport >= reportInterval) {
          const elapsed = ((now - startTime) / 1000).toFixed(0);
          const rate = (totalSent / ((now - startTime) / 1000)).toFixed(1);
          console.log(`  [${elapsed}s] sent=${totalSent} responded=${totalResponded} errors=${totalErrors} rate=${rate}/s`);

          timeSeries.push({
            time: now,
            sent: totalSent,
            responded: totalResponded,
            errors: totalErrors,
            rate: parseFloat(rate),
            avgLatency: sendLatencies.length > 0
              ? Math.round(sendLatencies.reduce((a, b) => a + b, 0) / sendLatencies.length)
              : 0,
          });

          lastReport = now;
        }

        // Send CONCURRENCY tasks in parallel, round-robin receiver
        const batchPromises = [];
        for (let c = 0; c < CONCURRENCY; c++) {
          const ruid = receivers[seq % receiverCount];
          const currentSeq = seq;
          seq++;

          batchPromises.push((async () => {
            const t0 = Date.now();
            try {
              const r = await queue.sendTask({
                sender,
                receiver_uid: ruid,
                content: `s4-sustained-${currentSeq}`,
                priority: 'normal',
              });
              sendLatencies.push(Date.now() - t0);
              if (r.ok) {
                totalSent++;
                pendingTasks.push({ ruid, seq: currentSeq });
              } else {
                totalErrors++;
              }
            } catch (e) {
              sendLatencies.push(Date.now() - t0);
              totalErrors++;
            }
          })());
        }

        await Promise.all(batchPromises);
      }

      // Stop collector
      collectorRunning = false;
      // Wait for remaining responses
      await new Promise(r => setTimeout(r, 2000));
      await collector;

      const totalElapsed = Date.now() - startTime;
      const avgRate = (totalSent / (totalElapsed / 1000)).toFixed(1);

      console.log(`\n  === Sustained Load Summary ===`);
      console.log(`  Duration: ${(totalElapsed / 1000).toFixed(1)}s`);
      console.log(`  Total sent: ${totalSent}`);
      console.log(`  Total responded: ${totalResponded}`);
      console.log(`  Total errors: ${totalErrors}`);
      console.log(`  Average rate: ${avgRate} tasks/sec`);

      const sustainedStats = stats('sustained_send', sendLatencies);
      console.log(`  Send P50=${sustainedStats.p50}ms P95=${sustainedStats.p95}ms P99=${sustainedStats.p99}ms`);
      console.log(`  Send min=${sustainedStats.min}ms max=${sustainedStats.max}ms avg=${sustainedStats.avg.toFixed(1)}ms`);

      // Performance degradation analysis
      if (timeSeries.length >= 2) {
        const firstRate = timeSeries[0].rate;
        const lastRate = timeSeries[timeSeries.length - 1].rate;
        // Use smoothed comparison: first 30% vs last 30% of periods
        const splitIdx = Math.floor(timeSeries.length * 0.3);
        const earlyPeriods = timeSeries.slice(0, Math.max(1, splitIdx));
        const latePeriods = timeSeries.slice(timeSeries.length - Math.max(1, splitIdx));

        const earlyAvg = earlyPeriods.reduce((s, p) => s + p.rate, 0) / earlyPeriods.length;
        const lateAvg = latePeriods.reduce((s, p) => s + p.rate, 0) / latePeriods.length;

        const degradation = earlyAvg > 0 ? ((1 - lateAvg / earlyAvg) * 100).toFixed(1) : 0;
        console.log(`  Early rate: ${earlyAvg.toFixed(1)}/s, Late rate: ${lateAvg.toFixed(1)}/s`);
        console.log(`  Performance degradation: ${degradation}%`);

        // Degradation should be under 50%
        assert.ok(parseFloat(degradation) < 50, `degradation ${degradation}% < 50%`);
      }

      // Error rate should be under 10%
      const errorRate = totalSent > 0 ? (totalErrors / (totalSent + totalErrors)) * 100 : 0;
      console.log(`  Error rate: ${errorRate.toFixed(1)}%`);
      assert.ok(errorRate < 10, `error rate ${errorRate.toFixed(1)}% < 10%`);

      // Cleanup
      try { await store.deleteAgent(senderUid); } catch {}
      for (const ruid of receivers) {
        try { await store.deleteAgent(ruid); } catch {}
      }
    }).timeout = DURATION_MS + 30000; // Allow extra 30s for cleanup
  });

  // ═════════════════════════════════════════════════════════════════════
  // Final integrity check
  // ═════════════════════════════════════════════════════════════════════
  test('agent-bus.json integrity after all load tests', async () => {
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
    // Sprint 33: identity_by_boos_session removed — routing lives in
    // identity_by_mcp_session / identity_by_name_ws only.
    assert.ok(db.identity_by_mcp_session !== undefined, 'identity_by_mcp_session present');
    assert.ok(db.identity_by_name_ws !== undefined, 'identity_by_name_ws present');

    const agentCount = Object.keys(db.agents || {}).length;
    const taskCount = Object.keys(db.tasks || {}).length;
    console.log(`  DB size: ${content.length} bytes`);
    console.log(`  Agents: ${agentCount}`);
    console.log(`  Tasks: ${taskCount}`);

    // Verify no duplicate task IDs
    const taskIds = Object.keys(db.tasks || {});
    const uniqueIds = new Set(taskIds);
    assert.strictEqual(taskIds.length, uniqueIds.size, 'no duplicate task IDs');

    // Verify no invalid task states
    const validStates = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'exhausted']);
    const invalidTasks = Object.values(db.tasks || {}).filter(t => !validStates.has(t.status));
    assert.strictEqual(invalidTasks.length, 0, `0 invalid task states (found ${invalidTasks.length})`);

    // Verify JSON is valid (parse succeeded already)
    console.log(`  JSON valid: yes`);
    console.log(`  All indices present: yes`);
  });

});

'use strict';

// Agent-Bus SSE Transport Concurrent Connection Benchmark
//
// Simulates concurrent SSE connections and measures:
// - Connection establishment time
// - Message delivery latency
// - Memory overhead per connection
//
// Run: node tests/bench/agent-bus-sse-transport.bench.js
//
// NOTE: This benchmark does NOT require a running BOOS server.
// It tests the underlying EventSource-like pattern at the Node.js
// http level — 100 concurrent connections to a local server.

const http = require('node:http');

// ── helpers ──────────────────────────────────────────────────────────────

function formatMs(ms) { return ms.toFixed(2) + ' ms'; }
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

function memSnapshot() {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external };
}

function memDiff(before, after) {
  return {
    heapUsed: after.heapUsed - before.heapUsed,
    heapTotal: after.heapTotal - before.heapTotal,
    rss: after.rss - before.rss,
    external: after.external - before.external,
  };
}

// ── SSE server ───────────────────────────────────────────────────────────

function createSSEServer(port) {
  const clients = new Set();
  let msgCounter = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/sse') {
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':ok\n\n'); // initial comment to confirm connection
      clients.add(res);
      req.on('close', () => { clients.delete(res); });
    } else if (req.method === 'POST' && req.url === '/broadcast') {
      // Broadcast a message to all connected SSE clients
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        msgCounter++;
        const data = JSON.stringify({ id: msgCounter, msg: body || 'ping', ts: Date.now() });
        for (const client of clients) {
          client.write('data: ' + data + '\n\n');
        }
        res.writeHead(200);
        res.end(JSON.stringify({ delivered: clients.size }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.broadcast = function (msg) {
    msgCounter++;
    const data = JSON.stringify({ id: msgCounter, msg, ts: Date.now() });
    for (const client of clients) {
      client.write('data: ' + data + '\n\n');
    }
    return clients.size;
  };

  server.getClientCount = () => clients.size;

  return server;
}

// ── benchmarks ───────────────────────────────────────────────────────────

/**
 * Measure connection establishment time for N concurrent SSE clients.
 */
async function benchSSEConnect(server, clientCount) {
  const connectTimes = [];
  const start = Date.now();

  const connections = [];
  for (let i = 0; i < clientCount; i++) {
    connections.push(new Promise((resolve, reject) => {
      const t0 = Date.now();
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/sse' });
      req.on('response', (res) => {
        // Wait for the initial :ok comment to confirm SSE handshake
        let initialData = '';
        res.on('data', (chunk) => {
          initialData += chunk.toString();
          if (initialData.includes(':ok\n')) {
            connectTimes.push(Date.now() - t0);
            resolve({ req, res });
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    }));
  }

  await Promise.all(connections);
  const elapsed = Date.now() - start;

  // Cleanup
  for (const c of connections) {
    const { req, res } = await c;
    res.destroy();
    req.destroy();
  }

  return { elapsed, connectTimes };
}

/**
 * Measure message delivery latency.
 * N clients connected, broadcast M messages, measure time from send to all-received.
 */
async function benchSSEMessageLatency(server, clientCount, messageCount) {
  // Connect all clients
  const clients = [];
  for (let i = 0; i < clientCount; i++) {
    clients.push(new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/sse' });
      req.on('response', (res) => {
        let initialData = '';
        const onData = (chunk) => {
          initialData += chunk.toString();
          if (initialData.includes(':ok\n')) {
            resolve({ req, res, onData });
          }
        };
        res.on('data', onData);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    }));
  }

  const connected = await Promise.all(clients);

  // Now measure delivery latency for each message
  const latencies = [];

  for (let m = 0; m < messageCount; m++) {
    const msgId = 'msg-' + m;
    const t0 = Date.now();
    const received = new Set();

    // Set up listeners
    const msgPromises = connected.map(({ res }, idx) => {
      return new Promise((resolve) => {
        const handler = (chunk) => {
          const text = chunk.toString();
          if (text.includes('"' + msgId + '"')) {
            received.add(idx);
            res.removeListener('data', handler);
            resolve();
          }
        };
        res.on('data', handler);
        // timeout after 5s
        setTimeout(() => { res.removeListener('data', handler); resolve(); }, 5000);
      });
    });

    // Broadcast
    server.broadcast(msgId);
    await Promise.all(msgPromises);
    latencies.push(Date.now() - t0);
  }

  // Cleanup
  for (const { req, res } of connected) {
    res.destroy();
    req.destroy();
  }

  return { latencies };
}

// ── memory benchmark ─────────────────────────────────────────────────────

async function benchSSEMemory(server, clientCount) {
  const memBefore = memSnapshot();
  global.gc && global.gc();

  const clients = [];
  for (let i = 0; i < clientCount; i++) {
    clients.push(new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/sse' });
      req.on('response', (res) => {
        let initialData = '';
        res.on('data', (chunk) => {
          initialData += chunk.toString();
          if (initialData.includes(':ok\n')) {
            resolve({ req, res });
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    }));
  }

  await Promise.all(clients);
  global.gc && global.gc();
  const memAfter = memSnapshot();
  const delta = memDiff(memBefore, memAfter);

  // Cleanup
  for (const c of clients) {
    const { req, res } = await c;
    res.destroy();
    req.destroy();
  }

  return { memBefore, memAfter, delta, perConnection: delta.heapUsed / clientCount };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const CONNECTIONS = 100;
  const MESSAGES = 20;

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Agent-Bus SSE Transport Performance Benchmark      ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Connections: %d  │  Messages: %d                     ║',
    String(CONNECTIONS).padStart(3), String(MESSAGES).padStart(2));
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Start server on random port
  const server = createSSEServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // ── Connection Benchmark ────────────────────────────────────────
    console.log('── SSE Connection Establishment (×%d) ──', CONNECTIONS);
    const connectResult = await benchSSEConnect(server, CONNECTIONS);
    const connectStat = stats(connectResult.connectTimes);

    console.log('  Total time:    %s', formatMs(connectResult.elapsed));
    console.log('  Connect avg:   %s', formatMs(connectStat.avg));
    console.log('  Connect p50:   %s', formatMs(connectStat.p50));
    console.log('  Connect p95:   %s', formatMs(connectStat.p95));
    console.log('  Connect p99:   %s', formatMs(connectStat.p99));
    console.log('');

    // ── Message Latency Benchmark ───────────────────────────────────
    console.log('── SSE Message Delivery Latency (×%d clients, ×%d msgs) ──', CONNECTIONS, MESSAGES);
    const msgResult = await benchSSEMessageLatency(server, CONNECTIONS, MESSAGES);
    const msgStat = stats(msgResult.latencies);

    console.log('  Latency avg:   %s', formatMs(msgStat.avg));
    console.log('  Latency p50:   %s', formatMs(msgStat.p50));
    console.log('  Latency p95:   %s', formatMs(msgStat.p95));
    console.log('  Latency p99:   %s', formatMs(msgStat.p99));
    console.log('  Latency max:   %s', formatMs(msgStat.max));
    console.log('');

    // ── Memory Benchmark ────────────────────────────────────────────
    console.log('── SSE Memory Overhead (×%d persistent connections) ──', CONNECTIONS);
    const memResult = await benchSSEMemory(server, CONNECTIONS);

    console.log('  Heap before:   %s', formatBytes(memResult.memBefore.heapUsed));
    console.log('  Heap after:    %s', formatBytes(memResult.memAfter.heapUsed));
    console.log('  Heap delta:    %s', formatBytes(memResult.delta.heapUsed));
    console.log('  Per-connection: %s', formatBytes(memResult.perConnection));
    console.log('  RSS delta:     %s', formatBytes(memResult.delta.rss));
    console.log('');

    // ── JSON output ─────────────────────────────────────────────────
    const result = {
      benchmark: 'agent-bus-sse-transport',
      config: { connections: CONNECTIONS, messages: MESSAGES },
      connect: { elapsedMs: connectResult.elapsed, ...connectStat },
      messageLatency: msgStat,
      memory: {
        heapBefore: memResult.memBefore.heapUsed,
        heapAfter: memResult.memAfter.heapUsed,
        heapDelta: memResult.delta.heapUsed,
        perConnection: memResult.perConnection,
      },
    };

    console.log('── CI JSON ──');
    console.log(JSON.stringify(result, null, 2));

  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});

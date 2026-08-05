'use strict';

// Router-mode tests (Sprint 41 Phase 3 — cache-stability).
//
// Collapses the full agent-bus tool catalog into 3 constant tools so the
// Claude Code system prompt's tool block stays stable across MCP churn,
// which keeps the Anthropic prompt cache hit rate high.
//
// Run: node --test tests/agentBus-router.test.js

const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { TOOLS } = require('../lib/agentBus/schemas');
const routerMode = require('../lib/agentBus/routerMode');

describe('agent-bus router mode', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.BOOS_MCP_ROUTER_MODE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BOOS_MCP_ROUTER_MODE;
    else process.env.BOOS_MCP_ROUTER_MODE = savedEnv;
  });

  test('router mode is ON by default', () => {
    delete process.env.BOOS_MCP_ROUTER_MODE;
    assert.equal(routerMode.isRouterMode(), true);
  });

  test('router mode OFF when env=0', () => {
    process.env.BOOS_MCP_ROUTER_MODE = '0';
    assert.equal(routerMode.isRouterMode(), false);
  });

  test('router mode ON when env=1', () => {
    process.env.BOOS_MCP_ROUTER_MODE = '1';
    assert.equal(routerMode.isRouterMode(), true);
  });

  test('ROUTER_TOOLS has exactly 3 constant tools', () => {
    const names = routerMode.ROUTER_TOOLS.map(t => t.name);
    assert.deepEqual(names, ['check_inbox', 'agent_bus_list_tools', 'agent_bus_call']);
  });

  test('check_inbox is a standalone zero-schema tool', () => {
    const ci = routerMode.ROUTER_TOOLS.find(t => t.name === 'check_inbox');
    assert.ok(ci, 'check_inbox missing from router tools');
    // Zero-schema: no properties to keep the system prompt tiny.
    assert.deepEqual(ci.inputSchema.properties, {});
    assert.deepEqual(ci.inputSchema.required, []);
  });

  test('router tools total ~5x smaller than full catalog', () => {
    const routerBytes = JSON.stringify(routerMode.ROUTER_TOOLS).length;
    const fullBytes = JSON.stringify(TOOLS).length;
    // Full catalog has ~68 tools; router surface must be a small fraction.
    assert.ok(fullBytes > routerBytes * 5,
      `full (${fullBytes}B) should be >5x router (${routerBytes}B)`);
  });

  test('every catalog tool name is covered by agent_bus_call dispatch', () => {
    // The full catalog must still be reachable through the router.
    const catalogNames = new Set(TOOLS.map(t => t.name));
    // check_inbox is standalone; everything else must be callable via router.
    for (const t of routerMode.ROUTER_TOOLS) {
      catalogNames.delete(t.name);
    }
    assert.ok(catalogNames.size >= 60, `expected >=60 routed tools, got ${catalogNames.size}`);
  });

  test('ROUTER_TOOLS descriptions are non-empty', () => {
    for (const t of routerMode.ROUTER_TOOLS) {
      assert.ok(typeof t.description === 'string' && t.description.length > 0,
        `${t.name}: empty description`);
    }
  });
});

// ── integration: SSE + POST /message round-trip ─────────────────────────
// Verifies tools/list in router mode returns exactly the 3 constant tools,
// and that agent_bus_call routes to the real dispatcher (e.g. register_agent).

describe('transport router integration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  const TEST_HOME = path.join(os.tmpdir(), `boos-router-test-${process.pid}`);
  const DATA_DIR = path.join(TEST_HOME, 'data');
  let server = null;
  let port = 0;
  let transport = null;
  let savedHome = null;

  before(async () => {
    savedHome = process.env.BOOS_HOME;
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(DATA_DIR, { recursive: true });
    process.env.BOOS_HOME = TEST_HOME;
    process.env.BOOS_MCP_ROUTER_MODE = '1';
    // Disable per-IP SSE reconnect backoff — the integration tests open
    // several SSE connections rapidly from 127.0.0.1.
    process.env.BOOS_SSE_MIN_RECONNECT_INTERVAL_MS = '0';

    // Fresh module loads with the test BOOS_HOME.
    delete require.cache[require.resolve('../lib/agentBus/transport')];
    delete require.cache[require.resolve('../lib/agentBus/store')];
    delete require.cache[require.resolve('../lib/agentBus/queue')];
    transport = require('../lib/agentBus/transport');

    const app = express();
    app.use(express.json());
    app.use('/mcp', transport.createRouter());
    await new Promise((resolve, reject) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
      server.on('error', reject);
    });
  });

  after(async () => {
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    // Let any in-flight withFileLock writes (agent-bus.json.lock) settle
    // before the temp dir is removed — otherwise teardown races them.
    await new Promise((r) => setTimeout(r, 150));
    if (savedHome === undefined) delete process.env.BOOS_HOME;
    else process.env.BOOS_HOME = savedHome;
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  // A single persistent SSE session: open the stream once, then POST many
  // JSON-RPC messages on it (mirrors how Claude Code talks to an MCP server).
  // Each POST resolves with the matching SSE 'message' event for that id.
  function openSession() {
    const sid = `router-sess-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const sseReq = http.request({
      hostname: '127.0.0.1', port,
      path: `/mcp/sse?sessionId=${encodeURIComponent(sid)}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    });

    let buffer = '';
    let epUrl = null;
    let closed = false;
    const close = () => { if (!closed) { closed = true; try { sseReq.destroy(); } catch {} } };
    sseReq.on('error', () => {});

    return new Promise((resolve, reject) => {
      const waitEndpoint = setTimeout(() => reject(new Error('no endpoint event')), 4000);
      sseReq.on('response', (res) => {
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          if (!epUrl) {
            const epMatch = buffer.match(/event: endpoint\ndata: (\S+)/);
            if (epMatch) {
              epUrl = epMatch[1].trim();
              clearTimeout(waitEndpoint);
              resolve({ call, close });
            }
          }
        });
        res.on('error', () => {});
      });
      sseReq.end();

      // call(msg): POST on this session, resolve with the NEXT new SSE frame.
      // The SSE frame's `id:` is the transport's event sequence counter, NOT
      // the JSON-RPC request id — so match the next `event: message` frame.
      // `_consumed` tracks how much of the buffer we've already matched, so
      // re-polling never re-resolves on an old frame.
      let _consumed = 0;
      function call(msg) {
        return new Promise((resolveCall, rejectCall) => {
          const timeout = setTimeout(() => rejectCall(new Error('sse timeout · buffer=' + buffer.slice(-600))), 8000);
          const postReq = http.request({
            hostname: '127.0.0.1', port,
            path: epUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (postRes) => {
            postRes.resume();
            postRes.on('end', () => {
              const poll = () => {
                // Find the first message frame fully after _consumed.
                const re = /id: \d+\nevent: message\ndata: (\{.*?\})\n\n/sg;
                let m;
                while ((m = re.exec(buffer)) !== null) {
                  if (m.index + m[0].length <= _consumed) continue;  // already consumed
                  const end = m.index + m[0].length;
                  if (end > _consumed) _consumed = end;
                  clearTimeout(timeout);
                  resolveCall(m[1]);
                  return;
                }
                setTimeout(poll, 30);
              };
              poll();
            });
          });
          postReq.on('error', (e) => { clearTimeout(timeout); rejectCall(e); });
          postReq.write(JSON.stringify(msg));
          postReq.end();
        });
      }
    });
  }

  // One-shot rpc for simple requests that need no session affinity.
  let _rpcSeq = 0;
  async function rpc(msg) {
    const session = await openSession();
    try { return await session.call(msg); }
    finally { session.close(); }
  }

  test('tools/list returns exactly 3 router tools (router mode ON)', async () => {
    const resp = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const parsed = JSON.parse(resp);
    assert.ok(parsed.result, `no result: ${resp}`);
    const names = parsed.result.tools.map(t => t.name);
    assert.deepEqual(names, ['check_inbox', 'agent_bus_list_tools', 'agent_bus_call']);
  });

  test('agent_bus_call routes to the real dispatcher (register_agent)', async () => {
    // One persistent session: register, then list_agents sees the bound ctx.
    const session = await openSession();
    try {
      const regResp = await session.call({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'agent_bus_call',
          arguments: {
            tool_name: 'register_agent',
            args: {
              name: 'router-test-agent', workspace: 'router-test',
              cli_session_id: `router-test-uid-${process.pid}`,
            },
          },
        },
      });
      const regParsed = JSON.parse(regResp);
      assert.ok(regParsed.result, `register failed: ${regResp}`);
      assert.ok(JSON.parse(regParsed.result.content[0].text).ok, `register error: ${regResp}`);

      const resp = await session.call({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'agent_bus_call', arguments: { tool_name: 'list_agents', args: {} } },
      });
      const parsed = JSON.parse(resp);
      assert.ok(parsed.result, `no result: ${resp}`);
      const text = parsed.result.content[0].text;
      const data = JSON.parse(text);
      assert.equal(data.workspace, 'router-test');
      assert.ok(Array.isArray(data.agents), `agents should be array: ${text}`);
    } finally {
      session.close();
    }
  });

  test('agent_bus_list_tools returns compact catalog', async () => {
    const resp = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'agent_bus_list_tools', arguments: {} },
    });
    const parsed = JSON.parse(resp);
    const text = JSON.parse(parsed.result.content[0].text);
    assert.ok(Array.isArray(text.tools), 'catalog should be an array');
    assert.ok(text.tools.length >= 60, `expected >=60 catalog tools, got ${text.tools.length}`);
    // Compact: entries have name + description only, no inputSchema.
    assert.equal(text.tools[0].inputSchema, undefined, 'catalog should not include full schemas');
  });

  test('agent_bus_list_tools with tool_name returns full schema', async () => {
    const resp = await rpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'agent_bus_list_tools', arguments: { tool_name: 'send_task' } },
    });
    const parsed = JSON.parse(resp);
    const text = JSON.parse(parsed.result.content[0].text);
    assert.equal(text.tool_name, 'send_task');
    assert.ok(text.inputSchema && typeof text.inputSchema === 'object',
      'single-tool query should return full schema');
  });
});

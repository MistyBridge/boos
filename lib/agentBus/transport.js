// MCP SSE transport layer — embedded in BOOS Express.
//
// Returns an Express Router with:
//   GET  /sse       — SSE stream (server → agent)
//   GET  /sse/ccsm  — BOOS internal watcher SSE
//   POST /message   — JSON-RPC (agent → server)
//   POST /api/call  — Simple JSON request/response (stdio bridges)
//   GET  /health    — Health check
//
// Adapted from agent-bus/mcp/bridge.js. Changed: mount(app) → createRouter().

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const express = require('express');
const { TOOLS } = require('./schemas');
const { isRouterMode, ROUTER_TOOLS } = require('./routerMode');
const { getRuntimePort } = require('../config');
const { dispatch } = require('./handlers');
const store = require('./store');
const queue = require('./queue');

// ── router catalog response ─────────────────────────────────────────────
// agent_bus_list_tools returns the compact catalog (name + one-line desc).
// With `tool_name` set, returns that single tool's full schema instead.

function _catalogResponse(toolName) {
  if (toolName && typeof toolName === 'string') {
    const tool = TOOLS.find(t => t.name === toolName);
    if (!tool) return { error: `unknown tool: ${toolName}`, tools: TOOLS.map(t => t.name) };
    return { tool_name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }
  return { tools: TOOLS.map(t => ({ name: t.name, description: t.description })) };
}

// ── session store ─────────────────────────────────────────────────────

const _sessions = new Map();
// TTL for inactive SSE sessions. Default 30 min (Sprint 34: was Infinity).
// Set BOOS_SESSION_TTL_MS=Infinity to disable pruning. Set to <ms> to customize.
const SESSION_TTL_MS = (() => {
  const v = process.env.BOOS_SESSION_TTL_MS;
  if (!v) return 30 * 60 * 1000;                    // default 30 min
  if (v === 'Infinity') return Infinity;              // explicit disable
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? Infinity : n;              // unparseable → disable
})();
let _pruneTimer = null;

// Sprint 34: SSE event buffer — saves recent N events per session for Last-Event-Id replay.
// Set BOOS_SSE_EVENT_BUFFER_SIZE=0 to disable buffering (old behavior).
const SSE_EVENT_BUFFER_SIZE = parseInt(process.env.BOOS_SSE_EVENT_BUFFER_SIZE, 10) || 100;

// Sprint 34: Minimum reconnect interval per client IP (prevents hammering).
// Set BOOS_SSE_MIN_RECONNECT_INTERVAL_MS=0 to disable backoff (old behavior).
// NOTE: `|| 1000` would break 0 (falsy → 1000), so parse explicitly.
const SSE_MIN_RECONNECT_INTERVAL_MS = (() => {
  const v = process.env.BOOS_SSE_MIN_RECONNECT_INTERVAL_MS;
  if (v === undefined || v === '') return 1000;      // default 1000ms
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 1000 : n;                  // 0 → disabled
})();
const _reconnectTimestamps = new Map();  // IP → last SSE connect ts

// Callback for notifying idleWatcher (or other modules) about session count changes.
let _onSessionCountChange = null;
function setSessionCountCallback(cb) { _onSessionCountChange = cb; }
function _notifyCount() { if (_onSessionCountChange) _onSessionCountChange(_sessions.size); }

// ── rate limiting ───────────────────────────────────────────────────

const MAX_SSE_CONNECTIONS = parseInt(process.env.BOOS_MAX_SSE_CONNECTIONS, 10) || 50;
const MSG_RATE_LIMIT = parseInt(process.env.BOOS_MSG_RATE_LIMIT, 10) || 100;
const MSG_RATE_WINDOW_MS = parseInt(process.env.BOOS_MSG_RATE_WINDOW_MS, 10) || 1000;
const _msgRateCounters = new Map();

function _checkSSELimit() {
  return _sessions.size >= MAX_SSE_CONNECTIONS;
}

function _checkMsgRate(sessionId) {
  const now = Date.now();
  let entries = _msgRateCounters.get(sessionId);
  if (!entries) { entries = []; _msgRateCounters.set(sessionId, entries); }
  const cutoff = now - MSG_RATE_WINDOW_MS;
  let i = 0;
  while (i < entries.length && entries[i] < cutoff) i++;
  entries.splice(0, i);
  const remaining = Math.max(0, MSG_RATE_LIMIT - entries.length);
  const reset = entries.length > 0 ? (entries[0] + MSG_RATE_WINDOW_MS) : (now + MSG_RATE_WINDOW_MS);
  if (entries.length >= MSG_RATE_LIMIT) return { ok: false, remaining, reset };
  entries.push(now);
  return { ok: true, remaining: Math.max(0, MSG_RATE_LIMIT - entries.length), reset };
}

// Periodic cleanup of stale rate-limit entries.
setInterval(() => {
  const now = Date.now();
  for (const [sid, entries] of _msgRateCounters) {
    let i = 0;
    while (i < entries.length && entries[i] < now - MSG_RATE_WINDOW_MS) i++;
    entries.splice(0, i);
    if (entries.length === 0) _msgRateCounters.delete(sid);
  }
}, 5 * 60_000).unref();

function _pruneStale() {
  const now = Date.now();
  for (const [sid, ctx] of _sessions) {
    if (now - ctx.createdAt > SESSION_TTL_MS) {
      try {  if (ctx.res) ctx.res.end();  } catch (e) { errReport.report("transport", "end", e); }
      _sessions.delete(sid);
      store.unbindSession(sid);
    }
  }
}

function _generateSessionId() {
  return 'mcp_' + require('node:crypto').randomUUID();
}

// ── Sprint 42: auto-register + PTY lifecycle binding ─────────────────────

// Auto-register an unknown uid on first contact. Metadata comes from the
// BOOS session record (title → name, workspace → workspace); role defaults
// to worker. register_agent remains for enriching metadata only.
async function _autoRegister(uid) {
  try {
    const { registerAgent } = require('./registry');
    const { validateWorkspace } = require('./workspace');
    const { findByCliSessionId } = require('../persistedSessions');
    let name = null, workspace = null, rec = null;
    try {
      rec = await findByCliSessionId(uid);
      if (rec) { name = rec.title || null; workspace = rec.workspace || null; }
    } catch (e) { errReport.report('transport', 'autoRegister-lookup', e, { uid: uid.slice(-8) }); }
    // Sprint 42: workspace fallback chain — record.workspace (if valid AND
    // existing) → cwd-prefix match against EXISTING workspaces → 'boos'
    // (if exists). Auto-registration must never CREATE a new workspace
    // (PM-only), and must not error on a record workspace that is valid
    // ASCII but simply does not exist as a registered workspace.
    const wsExists = store.listAllAgents().some((a) => a.workspace === workspace);
    if (!workspace || !validateWorkspace(workspace).valid || !wsExists) {
      workspace = await _matchWorkspaceByCwd(rec && rec.cwd) || 'boos';
    }
    const r = await registerAgent({
      name: name || ('agent-' + uid.slice(0, 8)),
      workspace,
      cliSessionId: uid,
      _internalRegister: true,   // skips the manual cli_session_id check
    });
    if (r.ok) console.log('[agent-bus] auto-registered', uid.slice(-8), 'as', r.agent && r.agent.name);
    else errReport.report('transport', 'autoRegister', new Error(r.error), { uid: uid.slice(-8) });
  } catch (e) {
    errReport.report('transport', 'autoRegister', e, { uid: uid.slice(-8) });
  }
}

// Match an existing workspace whose representative session shares the
// longest cwd prefix with the given one (same project root). Prevents
// auto-registration from dumping B-project agents into the wrong workspace.
async function _matchWorkspaceByCwd(cwd) {
  if (!cwd) return null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const target = norm(cwd);
  try {
    const { loadAll } = require('../persistedSessions');
    const all = await loadAll();
    const byUid = new Map(all.map((r) => [r.cliSessionId, r]));
    let best = null, bestLen = 0;
    for (const agent of store.listAllAgents()) {
      const rec = byUid.get(agent.uid);
      if (!rec || !rec.cwd) continue;
      const r = norm(rec.cwd);
      let common = 0;
      const lim = Math.min(target.length, r.length);
      while (common < lim && target[common] === r[common]) common++;
      if (common > bestLen) { bestLen = common; best = agent.workspace; }
    }
    return best;
  } catch (e) {
    errReport.report('transport', 'matchWorkspaceByCwd', e);
    return null;
  }
}

// Connection lifecycle == PTY lifecycle: when a PTY exits, close any SSE
// session bound to that agent. The header re-binds identity on reconnect.
function _registerOfflineHandler() {
  store.setAgentOfflineHandler((uid, sessionId) => {
    let closed = 0;
    for (const [sid, ctx] of _sessions) {
      if (ctx.uid === uid) {
        try { if (ctx.res) ctx.res.end(); } catch (e) { errReport.report('transport', 'offline-close', e); }
        _sessions.delete(sid);
        closed++;
      }
    }
    if (closed > 0) {
      console.log('[agent-bus] PTY exited, closed', closed, 'SSE session(s) for', uid.slice(-8));
    }
  });
}

function _configureSseSocket(req, res) {
  const sock = req.socket;
  if (sock) {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);
    sock.setTimeout(0);
  }
  res.flushHeaders();
}

function _sseEmit(ctx, jsonrpcMessage, eventType) {
  if (!ctx.res || ctx.res.destroyed || ctx.res.writableEnded) return;

  // Sprint 34: per-session event counter + ring buffer for Last-Event-Id replay.
  if (ctx._eventSeq === undefined) ctx._eventSeq = 0;
  if (!ctx._eventBuffer) ctx._eventBuffer = [];
  ctx._eventSeq++;
  const eventId = ctx._eventSeq;

  const data = JSON.stringify(jsonrpcMessage);
  const evType = eventType || 'message';

  // Buffer the event (ring buffer, capped at SSE_EVENT_BUFFER_SIZE).
  if (SSE_EVENT_BUFFER_SIZE > 0) {
    ctx._eventBuffer.push({ id: eventId, event: evType, data });
    while (ctx._eventBuffer.length > SSE_EVENT_BUFFER_SIZE) ctx._eventBuffer.shift();
  }

  const frame = `id: ${eventId}\nevent: ${evType}\ndata: ${data}\n\n`;
  const ok = ctx.res.write(frame);
  if (!ok) {
    ctx._drain = true;
    ctx.res.once('drain', () => { ctx._drain = false; });
  }
}

function notifyAgent(uid, method, params) {
  let notified = false;
  for (const [, ctx] of _sessions) {
    if (ctx.uid === uid && ctx.res) {
      _sseEmit(ctx, { jsonrpc: '2.0', method, params });
      notified = true;
    }
  }
  return notified;
}

// ── router factory ────────────────────────────────────────────────────

function createRouter() {
  if (!_pruneTimer) _pruneTimer = setInterval(_pruneStale, 60_000).unref();
  _registerOfflineHandler();   // Sprint 42: PTY exit closes the agent's SSE

  // Push notification bridge — when inbox goes 0→1, push SSE notification.
  queue.inboxEvents.on('task_available', (uid) => {
    const agent = store.getAgent(uid);
    notifyAgent(uid, 'notifications/agent_bus/inbox_updated', {
      uid,
      agent_name: agent ? agent.name : '',
      workspace: agent ? agent.workspace : '',
      message: 'A new task has arrived in your inbox.',
    });
  });

  const router = express.Router();

  // ── GET /sse ──────────────────────────────────────────────────────
  router.get('/sse', async (req, res) => {
    if (_checkSSELimit()) {
      return res.status(503).json({ error: 'too many SSE connections', limit: MAX_SSE_CONNECTIONS });
    }

    // Sprint 34: Reconnect backoff — throttle reconnects per client IP.
    if (SSE_MIN_RECONNECT_INTERVAL_MS > 0) {
      const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
      const lastConnect = _reconnectTimestamps.get(clientIp) || 0;
      const now = Date.now();
      if (now - lastConnect < SSE_MIN_RECONNECT_INTERVAL_MS) {
        const retryAfter = Math.ceil((lastConnect + SSE_MIN_RECONNECT_INTERVAL_MS - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'too many reconnection attempts', retryAfterSec: retryAfter });
      }
      _reconnectTimestamps.set(clientIp, now);
    }

    const sessionId = req.query.sessionId || _generateSessionId();
    const lastEventId = req.headers['last-event-id']; // Sprint 34

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    _configureSseSocket(req, res);
    res.on('error', () => {});

    const host = req.headers.host || ('127.0.0.1:' + getRuntimePort());
    const proto = req.connection && req.connection.encrypted ? 'https' : 'http';
    const endpoint = proto + '://' + host + '/mcp/message?sessionId=' + sessionId;
    res.write('event: endpoint\ndata: ' + endpoint + '\n\n');

    let existingUid = store.getSessionAgentUid(sessionId);
    // Sprint 42: header identity is authoritative when no session binding
    // exists — this is how agents regain their UID after SSE reconnects
    // without re-registering by hand.
    const headerUid = req.headers['x-boos-cli-session-id'];
    const headerUidValid = headerUid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(headerUid);
    const autoUid = (headerUidValid ? headerUid : null) || existingUid;

    // Sprint 34: Race migration — if old session with same uid exists,
    // migrate its event buffer so no events are lost on sessionId rotation.
    let replayEvents = [];
    let eventSeq = 0;
    let eventBuffer = [];
    const existingCtx = _sessions.get(sessionId);

    if (existingCtx) {
      // Reconnect to known session: preserve buffer, kill old response.
      eventSeq = existingCtx._eventSeq || 0;
      eventBuffer = existingCtx._eventBuffer || [];
      try {  if (existingCtx.res) existingCtx.res.end();  } catch (e) { errReport.report("transport", "end", e); }
    } else if (existingUid) {
      // Race: new sessionId but same uid — find and migrate old session's buffer.
      for (const [oldSid, oldCtx] of _sessions) {
        if (oldCtx.uid === existingUid && oldSid !== sessionId) {
          eventSeq = oldCtx._eventSeq || 0;
          eventBuffer = oldCtx._eventBuffer || [];
          try {  if (oldCtx.res) oldCtx.res.end();  } catch (e) { errReport.report("transport", "end", e); }
          _sessions.delete(oldSid);
          store.unbindSession(oldSid);
          break;
        }
      }
    }

    // Filter replay events after lastEventId.
    if (lastEventId && eventBuffer.length > 0) {
      const lastId = parseInt(lastEventId, 10);
      if (!isNaN(lastId)) {
        replayEvents = eventBuffer.filter(e => e.id > lastId);
      }
    } else {
      replayEvents = eventBuffer;
    }

    const ctx = {
      res, sessionId,
      uid: autoUid,
      workspace: null,
      createdAt: Date.now(),
      _eventSeq: eventSeq,
      _eventBuffer: eventBuffer,
    };

    _sessions.set(sessionId, ctx);
    _notifyCount();

    // Reconnect: update identity card's mcp_session_id so
    // auto-registration can resolve identity next time the agent calls in.
    if (autoUid) {
      try {
        await store.writeIdentity(autoUid, { mcp_session_id: sessionId });
        // Sprint 42 fix: header identity path must bind workspace too —
        // otherwise ctx.workspace stays null and send_task rejects with
        // "not attached to a workspace" / "cannot send tasks across workspaces".
        const agent = store.getAgent(autoUid);
        ctx.workspace = (agent && agent.workspace) || 'boos';
        // Sprint 42: auto-register when the uid is unknown — the uid IS the
        // cli session id, so there is nothing for the agent to fill in.
        if (!agent) {
          await _autoRegister(autoUid);
        }
      } catch (e) { errReport.report("transport", "writeIdentity", e); }
    } else {
      // New session with unknown uid — try to resolve agent identity
      // from PG or any recently active session on this IP.
      try {
        const adapter = require('../identityAdapter');
        const errReport = require("../errorReport");
        // Check PG: maybe this sessionId was previously stored.
        const pgIdentity = await adapter.resolveByMcp(sessionId);
        if (pgIdentity) {
          existingUid = pgIdentity.cli_session_id;
          ctx.uid = existingUid;
          ctx.workspace = pgIdentity.workspace;
          await store.writeIdentity(existingUid, { mcp_session_id: sessionId });
          console.log('[agent-bus] transport: resolved uid', existingUid.slice(-8),
            'from PG for new session', sessionId.slice(-12));
        }
      } catch { /* PG not available */ }
      // Fallback: scan _sessions for any recent connection from same agent.
      if (!existingUid) {
        // Try to match by checking identity_by_name_ws for the workspace.
        // We can't know the agent name yet, but register_agent will bind it.
      }
    }

    // Sprint 34: Replay buffered events missed during disconnection.
    if (replayEvents.length > 0) {
      for (const ev of replayEvents) {
        try {
          res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${ev.data}\n\n`);
        } catch { break; }
      }
    }

    const keepAlive = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(keepAlive); }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      // Sprint 30: clean up identity card's mcp_session_id so it doesn't
      // persist a stale pointer to a dead SSE connection. The identity
      // card's boos_session_id + agent_uid remain intact; only the
      // transient MCP transport binding is cleared.
      const closedUid = _sessions.get(sessionId)?.uid;
      _sessions.delete(sessionId);
      _notifyCount();
      store.unbindSession(sessionId);
      if (closedUid) {
        store.writeIdentity(closedUid, { mcp_session_id: null }).catch(() => {});
      }
    });
  });

  // ── GET /sse/ccsm ────────────────────────────────────────────────
  router.get('/sse/ccsm', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    _configureSseSocket(req, res);
    res.on('error', () => {});

    const host = req.headers.host || ('127.0.0.1:' + getRuntimePort());
    res.write('event: endpoint\ndata: http://' + host + '/mcp/message\n\n');

    const handler = (uid) => {
      const agent = store.getAgent(uid);
      const payload = JSON.stringify({
        type: 'task_available',
        uid,
        agent_name: agent ? agent.name : '',
        workspace: agent ? agent.workspace : '',
        timestamp: new Date().toISOString(),
      });
      try {  res.write('event: task\ndata: ' + payload + '\n\n');  } catch (e) { errReport.report("transport", "write", e); }
    };

    queue.inboxEvents.on('task_available', handler);

    const keepAlive = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(keepAlive); }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      queue.inboxEvents.removeListener('task_available', handler);
    });
  });

  // ── POST /message ─────────────────────────────────────────────────
  router.post('/message', async (req, res) => {
    const sessionId = req.query.sessionId;
    const ctx = sessionId ? _sessions.get(sessionId) : null;

    if (!ctx) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found — open GET /mcp/sse first' },
        id: req.body ? req.body.id : null,
      });
    }

    // Per-session rate limit.
    const rate = _checkMsgRate(sessionId);
    if (!rate.ok) {
      return res
        .status(429)
        .set('X-RateLimit-Remaining', String(rate.remaining))
        .set('X-RateLimit-Reset', String(Math.ceil(rate.reset / 1000)))
        .json({
          error: 'rate limit exceeded',
          limit: MSG_RATE_LIMIT,
          window_ms: MSG_RATE_WINDOW_MS,
        });
    }
    // Attach rate-limit info to successful responses.
    res.set('X-RateLimit-Remaining', String(rate.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(rate.reset / 1000)));

    ctx.createdAt = Date.now();

    const { method, params, id } = req.body || {};

    if (!method || typeof method !== 'string') {
      res.status(200).end();
      _sseEmit(ctx, {
        jsonrpc: '2.0', id: id || null,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      });
      return;
    }

    res.status(200).end();

    try {
      switch (method) {
        case 'initialize':
          _sseEmit(ctx, {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'agent-bus', version: '2.0.0' },
            },
          });
          break;

        case 'notifications/initialized':
          break;

        case 'tools/list': {
          // Router mode collapses the full catalog to 3 constant tools (see
          // routerMode.js) so the system prompt's tool block never churns as
          // agent-bus reconnects. Non-router mode returns the full catalog.
          const tools = isRouterMode() ? ROUTER_TOOLS : TOOLS;
          _sseEmit(ctx, {
            jsonrpc: '2.0', id,
            result: { tools },
          });
          break;
        }

        case 'tools/call': {
          const toolName = params ? params.name : null;
          const args = params ? (params.arguments || {}) : {};
          let result;
          if (isRouterMode() && toolName === 'agent_bus_list_tools') {
            result = _catalogResponse(args && args.tool_name);
          } else if (isRouterMode() && toolName === 'agent_bus_call') {
            const inner = args && args.tool_name;
            const innerArgs = (args && args.args) || {};
            if (!inner || typeof inner !== 'string') {
              result = { error: 'agent_bus_call requires tool_name (string)' };
            } else {
              result = await dispatch(inner, innerArgs, ctx);
            }
          } else {
            result = await dispatch(toolName, args, ctx);
          }
          if (ctx.uid) {
            try {  await store.touchAgent(ctx.uid);  } catch (e) { errReport.report("transport", "touchAgent", e); }
          }
          const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
          _sseEmit(ctx, { jsonrpc: '2.0', id, result: { content } });
          break;
        }

        default:
          _sseEmit(ctx, {
            jsonrpc: '2.0', id,
            error: { code: -32601, message: 'Method not found: ' + method },
          });
      }
    } catch (err) {
      _sseEmit(ctx, {
        jsonrpc: '2.0', id,
        error: { code: -32603, message: err.message },
      });
    }
  });

  // ── POST /api/call ─────────────────────────────────────────────────
  router.post('/api/call', async (req, res) => {
    const { toolName, args: bodyArgs, arguments: bodyArgs2, sessionId } = req.body || {};
    const args = bodyArgs || bodyArgs2 || {};

    if (!toolName || !sessionId) {
      return res.status(400).json({ error: 'Missing toolName or sessionId' });
    }

    let ctx = _sessions.get(sessionId);
    if (!ctx) {
      const headerUid = req.headers['x-boos-cli-session-id'];
      const headerUidValid = headerUid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(headerUid);
      const storedUid = store.getSessionAgentUid(sessionId);
      ctx = { res: null, sessionId, uid: (headerUidValid ? headerUid : null) || storedUid || null, workspace: null, createdAt: Date.now() };
      _sessions.set(sessionId, ctx);
      _notifyCount();
    }
    ctx.createdAt = Date.now();

    try {
      const result = await dispatch(toolName, args, ctx);
      if (ctx.uid) {
        try {  await store.touchAgent(ctx.uid);  } catch (e) { errReport.report("transport", "touchAgent", e); }
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /health ────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    let agentCount = 0;
    for (const [, ctx] of _sessions) {
      if (ctx.uid) agentCount++;
    }
    let staleAgents = 0;
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      staleAgents = store.countStaleAgents(cutoff);
    } catch (e) { errReport.report("transport", "countStaleAgents", e); }
    res.json({
      ok: true,
      active_sessions: _sessions.size,
      registered_agents: agentCount,
      stale_agents: staleAgents,
      uptime: process.uptime(),
      pid: process.pid,
    });
  });

  return router;
}

module.exports = { createRouter, notifyAgent, setSessionCountCallback };

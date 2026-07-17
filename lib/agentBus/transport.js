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

const express = require('express');
const { TOOLS } = require('./schemas');
const { getRuntimePort } = require('../config');
const { dispatch } = require('./handlers');
const store = require('./store');
const queue = require('./queue');

// ── session store ─────────────────────────────────────────────────────

const _sessions = new Map();
// TTL for inactive SSE sessions. Infinity = never expire (default).
// Set BOOS_SESSION_TTL_MS=<ms> to enable automatic pruning of stale connections.
const SESSION_TTL_MS = process.env.BOOS_SESSION_TTL_MS
  ? parseInt(process.env.BOOS_SESSION_TTL_MS, 10)
  : Infinity;
let _pruneTimer = null;

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
      try { if (ctx.res) ctx.res.end(); } catch {}
      _sessions.delete(sid);
      store.unbindSession(sid);
    }
  }
}

function _generateSessionId() {
  return 'mcp_' + require('node:crypto').randomUUID();
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

function _sseEmit(ctx, jsonrpcMessage) {
  if (!ctx.res || ctx.res.destroyed || ctx.res.writableEnded) return;
  const data = JSON.stringify(jsonrpcMessage);
  const frame = 'event: message\ndata: ' + data + '\n\n';
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
  if (!_pruneTimer) _pruneTimer = setInterval(_pruneStale, 60_000);

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
  router.get('/sse', (req, res) => {
    if (_checkSSELimit()) {
      return res.status(503).json({ error: 'too many SSE connections', limit: MAX_SSE_CONNECTIONS });
    }

    const sessionId = req.query.sessionId || _generateSessionId();

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

    const existingUid = store.getSessionAgentUid(sessionId);
    const ctx = {
      res, sessionId,
      uid: existingUid || null,
      workspace: null,
      createdAt: Date.now(),
    };

    _sessions.set(sessionId, ctx);
    _notifyCount();

    const keepAlive = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(keepAlive); }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      _sessions.delete(sessionId);
      _notifyCount();
      store.unbindSession(sessionId);
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
      try { res.write('event: task\ndata: ' + payload + '\n\n'); } catch {}
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

        case 'tools/list':
          _sseEmit(ctx, {
            jsonrpc: '2.0', id,
            result: { tools: TOOLS },
          });
          break;

        case 'tools/call': {
          const toolName = params ? params.name : null;
          const args = params ? (params.arguments || {}) : {};
          const result = await dispatch(toolName, args, ctx);
          if (ctx.uid) {
            try { await store.touchAgent(ctx.uid); } catch {}
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
      const existingUid = store.getSessionAgentUid(sessionId);
      ctx = { res: null, sessionId, uid: existingUid || null, workspace: null, createdAt: Date.now() };
      _sessions.set(sessionId, ctx);
      _notifyCount();
    }
    ctx.createdAt = Date.now();

    try {
      const result = await dispatch(toolName, args, ctx);
      if (ctx.uid) {
        try { await store.touchAgent(ctx.uid); } catch {}
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
    } catch {}
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

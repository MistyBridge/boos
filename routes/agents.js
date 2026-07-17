// Agent state API — bridges agent-bus agents with BOOS sessions.
//
// Sprint 9: provides a unified view of agent state so the frontend
// Agent Canvas can reflect agent-bus activity (register, wake, task,
// idle/busy) rather than just PTY terminal output frames.
//
// GET /api/agents — merged list of agent-bus agents + BOOS sessions
// GET /api/agents/events — SSE stream of agent-bus state changes

'use strict';

const persistedSessions = require('../lib/persistedSessions');
const webTerminal = require('../lib/webTerminal');

function register(app, { asyncH }) {

  // GET /api/agents — merged agent-bus + BOOS session state.
  app.get('/api/agents', asyncH(async (_req, res) => {
    let store;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    let resolver;
    try { resolver = require('../lib/identityResolver').getResolver(); } catch { resolver = null; }

    const sessions = await persistedSessions.loadAll();
    const live = sessions.filter((s) => !s.deletedAt);

    // Build a map of sessionId → agent-bus agent (via bindSession).
    const sessionAgentMap = new Map(); // sessionId → agentBusAgent
    const agentList = [];
    if (store) {
      const allAgents = store.listAllAgents();
      for (const a of allAgents) {
        // Use IdentityResolver to get canonical BOOS session ID.
        // Falls back to transport session ID if resolver unavailable.
        let boosSid = null;
        try {
          boosSid = resolver ? resolver.canonical(a.uid) : null;
        } catch {}
        const transportSid = store.getSessionByAgentUid(a.uid);
        const sid = boosSid || transportSid;
        const session = sid ? live.find((s) => s.id === sid) : null;
        agentList.push({
          uid: a.uid,
          name: a.name,
          workspace: a.workspace,
          role: a.role || 'worker',
          capabilities: a.capabilities || [],
          registeredAt: a.registered_at,
          agentBusActivity: _inferAgentActivity(store, a.uid),
          pendingTasks: store.countPendingTasks(a.uid),
          sessionId: sid || null,
          sessionStatus: session ? session.status : null,
          sessionCwd: session ? session.cwd : null,
        });
        if (sid) sessionAgentMap.set(sid, a);
      }
    }

    // Add sessions that have no agent-bus binding (shown as "offline").
    for (const s of live) {
      if (!sessionAgentMap.has(s.id)) {
        const term = webTerminal.get(s.id);
        agentList.push({
          uid: null,
          name: s.title || s.id.slice(-8),
          workspace: s.workspace,
          role: 'unknown',
          capabilities: [],
          registeredAt: null,
          agentBusActivity: term && !term.exitedAt ? 'ptylive' : 'offline',
          pendingTasks: 0,
          sessionId: s.id,
          sessionStatus: s.status,
          sessionCwd: s.cwd,
        });
      }
    }

    res.json({ ok: true, agents: agentList, count: agentList.length });
  }));

  // GET /api/agents/events — SSE stream of agent state changes.
  // Clients open a long-lived SSE connection and receive JSON events
  // when agent-bus activities change (register, task, wake, idle).
  const MAX_SSE_CONNECTIONS = 50;
  app.get('/api/agents/events', (req, res) => {
    if (_sseClients.size >= MAX_SSE_CONNECTIONS) {
      return res.status(503).json({ error: 'too many SSE connections', limit: MAX_SSE_CONNECTIONS });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');

    // Register this client.
    const cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    _sseClients.set(cid, res);
    req.on('close', () => _sseClients.delete(cid));

    // Bridge: wire notifications.js → this SSE channel.
    try {
      const notifications = require('../lib/agentBus/notifications');
      notifications.setFrontendNotify(notifyAgentActivity);
    } catch {}

    // Send initial snapshot.
    let store;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    if (store) {
      const allAgents = store.listAllAgents();
      res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: allAgents.map((a) => ({
        uid: a.uid, name: a.name, pendingTasks: store.countPendingTasks(a.uid),
      })) })}\n\n`);
    }
  });
}

// ── SSE broadcast ────────────────────────────────────────────────────────

const _sseClients = new Map();

// Called by notifications.js when agent-bus delivers a task or wake.
// Pushes an activity update to all connected SSE clients.
function notifyAgentActivity(sessionId, activity, meta = {}) {
  const event = JSON.stringify({
    sessionId,
    activity,   // 'working' | 'idle' | 'busy'
    ...meta,
    timestamp: new Date().toISOString(),
  });
  for (const [, res] of _sseClients) {
    try { res.write(`event: activity\ndata: ${event}\n\n`); } catch {}
  }
}

// Called when an agent registers or deregisters.
function notifyAgentRegistry(action, agent) {
  const event = JSON.stringify({ action, agent, timestamp: new Date().toISOString() });
  for (const [, res] of _sseClients) {
    try { res.write(`event: registry\ndata: ${event}\n\n`); } catch {}
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function _inferAgentActivity(store, uid) {
  // If agent has in_progress tasks → busy.
  // Otherwise idle.
  try {
    const tasks = store.listMyTasks ? store.listMyTasks(uid) : [];
    const hasInProgress = tasks.some((t) => t.status === 'in_progress');
    return hasInProgress ? 'busy' : 'idle';
  } catch {
    return 'idle';
  }
}

module.exports = { register, notifyAgentActivity, notifyAgentRegistry };

// Agent state API — bridges agent-bus agents with BOOS sessions.
//
// Sprint 9: provides a unified view of agent state so the frontend
// Agent Canvas can reflect agent-bus activity (register, wake, task,
// idle/busy) rather than just PTY terminal output frames.
//
// GET /api/agents — merged list of agent-bus agents + BOOS sessions
// GET /api/agents/events — SSE stream of agent-bus state changes

'use strict';
const errReport = require('../lib/errorReport');   // Sprint 42: no silent failures


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
        } catch (e) { errReport.report("routes_agents", "canonical", e); }
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
    } catch (e) { errReport.report("routes_agents", "setFrontendNotify", e); }

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

  // ── Agent Activation REST API (Sprint 19) ──────────────────────────────

  // POST /api/agents/wake — wake a single agent by UID or name+workspace.
  app.post('/api/agents/wake', asyncH(async (req, res) => {
    const body = req.body || {};
    const uid = String(body.uid || '').trim();
    const name = String(body.name || '').trim();
    const workspace = String(body.workspace || '').trim();
    const urgency = (String(body.urgency || '').toLowerCase() === 'urgent') ? 'urgent' : 'normal';

    // Sprint 30: prefer uid as canonical index. name+workspace is a
    // deprecated fallback kept for backward compatibility.
    if (!uid && (!name || !workspace)) {
      return res.status(400).json({ error: 'uid required (name+workspace is deprecated)' });
    }
    if (body.urgency && !['normal', 'urgent'].includes(String(body.urgency).toLowerCase())) {
      return res.status(400).json({ error: 'urgency must be "normal" or "urgent"' });
    }

    let store, notifications, handlers;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    if (!store) return res.status(500).json({ error: 'agent-bus store unavailable' });

    // Resolve agent.
    let agent;
    if (uid) {
      agent = store.getAgent(uid);
      if (!agent) return res.status(400).json({ ok: false, error: 'agent not found by uid: ' + uid });
    } else {
      agent = store.findAgentByNameWs(name, workspace);
      if (!agent) return res.status(400).json({ ok: false, error: 'agent not found: ' + name + ' / ' + workspace });
    }

    // Optional: launch BOOS session before waking (non-fatal if fails).
    if (body.launch === true || body.launch === 'true') {
      try {
        handlers = require('../lib/agentBus/handlers');
        await handlers._internalLaunchAgentSession(agent.uid, agent.name, agent.workspace);
      } catch (e) { errReport.report("routes_agents", "_internalLaunchAgentSession", e); }
    }

    try { notifications = require('../lib/agentBus/notifications'); } catch { notifications = null; }
    if (!notifications) return res.status(500).json({ error: 'notifications module unavailable' });

    const result = await notifications.wakeAgent(agent.uid, {
      urgency,
      message: String(body.message || '').slice(0, 256),
    });
    res.json(result);
  }));

  // POST /api/agents/wake-all — wake all agents with pending tasks.
  app.post('/api/agents/wake-all', asyncH(async (req, res) => {
    const body = req.body || {};
    const wsFilter = String(body.workspace || '').trim() || null;
    const urgency = (String(body.urgency || '').toLowerCase() === 'urgent') ? 'urgent' : 'normal';

    if (body.urgency && !['normal', 'urgent'].includes(String(body.urgency).toLowerCase())) {
      return res.status(400).json({ error: 'urgency must be "normal" or "urgent"' });
    }

    let store, notifications;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    if (!store) return res.status(500).json({ error: 'agent-bus store unavailable' });
    try { notifications = require('../lib/agentBus/notifications'); } catch { notifications = null; }
    if (!notifications) return res.status(500).json({ error: 'notifications module unavailable' });

    const pendingUids = store.listAllPendingQueues();
    if (pendingUids.length === 0) {
      return res.json({ ok: true, triggered: 0, results: [], hint: 'No agents have pending tasks.' });
    }

    // Resolve + filter by workspace.
    const targets = [];
    for (const uid of pendingUids) {
      const a = store.getAgent(uid);
      if (!a) continue;
      if (wsFilter && a.workspace !== wsFilter) continue;
      targets.push(a);
    }

    const message = String(body.message || '').slice(0, 256);
    const results = await Promise.all(targets.map(async (a) => {
      try {
        const r = await notifications.wakeAgent(a.uid, { urgency, message });
        return { uid: a.uid, name: a.name, ...r };
      } catch (e) {
        return { uid: a.uid, name: a.name, ok: false, error: e.message };
      }
    }));

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    const hintParts = ['Successfully woke ' + succeeded + ' agents.'];
    if (failed > 0) hintParts.push(failed + ' failures.');

    res.json({ ok: true, triggered: results.length, results, hint: hintParts.join(' ') });
  }));

  // GET /api/agents/status — enriched agent status with PTY/session detail.
  app.get('/api/agents/status', asyncH(async (req, res) => {
    const uid = String(req.query.uid || '').trim();
    const name = String(req.query.name || '').trim();
    const workspace = String(req.query.workspace || '').trim();

    let store;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    if (!store) return res.status(500).json({ error: 'agent-bus store unavailable' });

    // Resolve target agent(s).
    let agents = [];
    if (uid) {
      const a = store.getAgent(uid);
      if (!a) return res.status(404).json({ error: 'agent not found by uid: ' + uid });
      agents = [a];
    } else if (name && workspace) {
      const a = store.findAgentByNameWs(name, workspace);
      if (!a) return res.status(404).json({ error: 'agent not found: ' + name + ' / ' + workspace });
      agents = [a];
    } else {
      agents = store.listAllAgents();
    }

    // Load BOOS sessions + identity resolver once.
    let sessions = [], resolver = null, webTerminalMod = null;
    try {
      const ps = require('../lib/persistedSessions');
      const errReport = require("../lib/errorReport");
      sessions = await ps.loadAll();
    } catch (e) { errReport.report("routes_agents", "loadAll", e); }
    try {  resolver = require('../lib/identityResolver').getResolver();  } catch (e) { errReport.report("routes_agents", "require", e); }
    try {  webTerminalMod = require('../lib/webTerminal');  } catch (e) { errReport.report("routes_agents", "require", e); }

    const enriched = agents.map((agent) => {
      let boosSid = null;
      try {  boosSid = resolver ? resolver.canonical(agent.uid) : null;  } catch (e) { errReport.report("routes_agents", "canonical", e); }
      const transportSid = store.getSessionByAgentUid(agent.uid);
      const sid = boosSid || transportSid;
      const session = sid ? sessions.find((s) => s.id === sid && !s.deletedAt) : null;

      let ptyInfo = null;
      if (session && webTerminalMod) {
        const term = webTerminalMod.get(session.id);
        ptyInfo = term ? {
          pid: term.meta?.pid || null,
          exitedAt: term.exitedAt || null,
        } : null;
      }

      const online = !!(session && session.status === 'running' && ptyInfo && !ptyInfo.exitedAt);

      let activeTasks = [];
      try {  activeTasks = store.listActiveTasks(agent.uid);  } catch (e) { errReport.report("routes_agents", "listActiveTasks", e); }
      const pendingTasks = store.countPendingTasks(agent.uid);

      return {
        uid: agent.uid,
        name: agent.name,
        workspace: agent.workspace,
        role: agent.role || 'worker',
        capabilities: agent.capabilities || [],
        online,
        boos_session_id: sid || null,
        session_status: session ? session.status : null,
        pty_info: ptyInfo,
        pending_tasks: pendingTasks,
        active_tasks: activeTasks.slice(0, 10).map((t) => ({
          task_id: t.task_id,
          status: t.status,
          priority: t.priority,
          content_preview: (t.content || '').slice(0, 100),
          created_at: t.created_at,
        })),
        registered_at: agent.registered_at || null,
        last_seen_at: agent.last_seen_at || null,
        unresponsive: agent.unresponsive || false,
      };
    });

    let summary = null;
    if (!uid && !(name && workspace)) {
      const onlineCount = enriched.filter((a) => a.online).length;
      const busyCount = enriched.filter((a) => a.active_tasks.some((t) => t.status === 'in_progress')).length;
      const totalPending = enriched.reduce((sum, a) => sum + a.pending_tasks, 0);
      summary = { online: onlineCount, offline: enriched.length - onlineCount, busy: busyCount, total_pending_tasks: totalPending };
    }

    if (agents.length === 1) {
      res.json({ ok: true, agent: enriched[0] });
    } else {
      res.json({ ok: true, agents: enriched, count: enriched.length, summary });
    }
  }));

  // ── Sprint 24: TeamCompact ──────────────────────────────────────────

  // POST /api/agents/compact — inject /compact into all idle worker PTYs.
  app.post('/api/agents/compact', asyncH(async (req, res) => {
    const ws = String((req.body || {}).workspace || '').trim();
    if (!ws) return res.status(400).json({ error: 'workspace required' });

    // Gate 1: supervisor only (check via agent-bus role).
    const agentUid = req.headers['x-agent-uid'] || '';
    let store, isSupervisor = false;
    try { store = require('../lib/agentBus/store'); } catch { store = null; }
    if (store && agentUid) {
      const agent = store.getAgent(agentUid);
      isSupervisor = !!(agent && agent.role === 'supervisor');
    }
    if (!isSupervisor) return res.status(403).json({ error: 'supervisor only' });

    let notifications;
    try { notifications = require('../lib/agentBus/notifications'); } catch { notifications = null; }
    if (!notifications) return res.status(500).json({ error: 'notifications module unavailable' });

    const result = await notifications.compactAllWorkers(ws, {
      milestone: (req.body || {}).milestone || null,
      note: (req.body || {}).note || null,
    });
    res.status(result.ok ? 200 : 400).json(result);
  }));
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

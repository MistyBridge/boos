// MCP tool handler implementations.
//
// Adapted from agent-bus/mcp/handlers.js. Changed: require paths point to
// sibling modules in lib/agentBus/.

'use strict';

const registry = require('./registry');
const queue = require('./queue');
const store = require('./store');
const notifications = require('./notifications');

// Sprint 5: workflow engine + decision system (lazy-loaded to avoid circular deps).
function _workflowEngine() {
  return require('../workflowEngine');
}
function _decisionSystem() {
  return require('../decisionSystem');
}

// ── role helpers (Sprint 5) ─────────────────────────────────────────────

function _getRole(uid) {
  const agent = store.getAgent(uid);
  if (!agent) return null;
  return agent.role || 'worker';
}

function _requireSupervisor(ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (_getRole(ctx.uid) !== 'supervisor') {
    return { error: 'supervisor role required', role: _getRole(ctx.uid) };
  }
  return null;
}

function _requireSelfOrSupervisor(ctx, targetUid) {
  if (ctx.uid === targetUid) return null;
  return _requireSupervisor(ctx);
}

// ── content sanitization ───────────────────────────────────────────────
// Strip ANSI escape sequences and control characters (except \n, \t, \r).
// Applied to task content and broadcast messages to prevent terminal
// injection and rendering issues in agent UIs.

const CONTENT_MAX_BYTES = 64 * 1024; // 64 KB

function sanitizeContent(str) {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, CONTENT_MAX_BYTES)
    // Strip ANSI/OSC sequences FIRST — they contain control chars (ESC, BEL)
    // that would be individually stripped by the control-char pass below,
    // breaking sequence-boundary detection.
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')              // ANSI CSI sequences (ESC [ ... letter)
    .replace(/\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (ESC ] ... BEL/ST)
    // Then strip remaining control characters except \n, \t, \r.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── broadcast rate limiting ────────────────────────────────────────────
// Simple sliding-window: max BROADCAST_LIMIT calls per BROADCAST_WINDOW_MS
// per agent UID. Prevents workspace-wide DoS via infinite broadcast loops.

const BROADCAST_WINDOW_MS = 60_000;  // 1 minute
const BROADCAST_LIMIT = 10;           // max 10 broadcasts per window
const _broadcastTimestamps = new Map();

function checkBroadcastRate(uid) {
  const now = Date.now();
  const timestamps = _broadcastTimestamps.get(uid) || [];
  const recent = timestamps.filter((t) => now - t < BROADCAST_WINDOW_MS);
  if (recent.length >= BROADCAST_LIMIT) return { allowed: false, retryAfterMs: BROADCAST_WINDOW_MS - (now - recent[0]) };
  recent.push(now);
  _broadcastTimestamps.set(uid, recent);
  return { allowed: true };
}

async function dispatch(toolName, args, ctx) {
  switch (toolName) {
    case 'register_agent':    return _register(args, ctx);
    case 'deregister_agent':  return _deregister(args, ctx);
    case 'list_agents':       return _listAgents(args, ctx);
    case 'send_task':         return _sendTask(args, ctx);
    case 'check_inbox':       return _checkInbox(args, ctx);
    case 'cancel_task':       return _cancelTask(args, ctx);
    case 'interrupt_task':    return _interruptTask(args, ctx);
    case 'respond_task':      return _respondTask(args, ctx);
    case 'list_my_tasks':     return _listMyTasks(args, ctx);
    case 'get_task':          return _getTask(args, ctx);
    case 'broadcast':         return _broadcast(args, ctx);
    // Sprint 5: Workflow Engine
    case 'define_workflow':   return _defineWorkflow(args, ctx);
    case 'add_stage':         return _addStage(args, ctx);
    case 'add_dependency':    return _addDependency(args, ctx);
    case 'activate_workflow': return _activateWorkflow(args, ctx);
    // Sprint 5: Decision System
    case 'request_decision':  return _requestDecision(args, ctx);
    case 'check_decisions':   return _checkDecisions(args, ctx);
    // Sprint 5: Supervisor Privileges
    case 'assign_task':       return _assignTask(args, ctx);
    case 'list_all_agents':   return _listAllAgents(args, ctx);
    case 'kill_worker':       return _killWorker(args, ctx);
    // Sprint 5: BOOS Terminal listing
    case 'boos_terminal_list': return _boosTerminalList(args, ctx);
    // Sprint 6: Agent Wake-Up
    case 'wake_agent':         return _wakeAgent(args, ctx);
    default:                  return { error: 'unknown tool: ' + toolName };
  }
}

async function _register(args, ctx) {
  const { name, intro, workspace, role, capabilities } = args;
  if (!name || !workspace) {
    return { error: 'name and workspace are required' };
  }

  const result = registry.registerAgent({ name, intro: intro || '', workspace, role, capabilities });

  if (!result.ok) return { error: result.error };

  ctx.uid = result.uid;
  ctx.workspace = workspace;
  await store.bindSession(ctx.sessionId, result.uid, workspace);

  return {
    ok: true,
    uid: result.uid,
    role: role || 'worker',
    reconnected: result.reconnected || false,
    pending_tasks: result.pending_tasks || 0,
    hint: result.reconnected
      ? 'Reconnected with UID ' + result.uid + '. You have ' + result.pending_tasks + ' pending task(s). Call check_inbox to fetch them.'
      : 'Registered as ' + result.uid + '. Your UID is persistent — you\'ll reconnect with the same identity across sessions.',
  };
}

async function _deregister(args, ctx) {
  if (!ctx.uid) return { error: 'not registered yet' };
  await store.unbindSession(ctx.sessionId);
  const r = registry.deregisterAgent(ctx.uid);
  ctx.uid = null;
  ctx.workspace = null;
  return { ok: true, existed: r.existed };
}

async function _listAgents(args, ctx) {
  if (!ctx.workspace) return { error: 'not attached to a workspace — register_agent first' };
  const agents = registry.listAgentsInWorkspace(ctx.workspace);
  return {
    workspace: ctx.workspace,
    agents: agents.map((a) => ({ uid: a.uid, name: a.name, intro: a.intro })),
    self_uid: ctx.uid,
  };
}

async function _sendTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const myself = registry.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };

  const receiver = registry.getAgent(args.to_uid);
  if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
  if (receiver.workspace !== ctx.workspace) {
    return { error: 'cannot send tasks across workspaces' };
  }

  const r = queue.sendTask({
    sender: { uid: ctx.uid, name: myself.name, intro: myself.intro },
    receiver_uid: args.to_uid,
    content: sanitizeContent(args.content),
    priority: args.priority || 'normal',
  });
  if (r.ok) return { ok: true, task: r.task, was_empty: r.was_empty };
  return { error: r.error };
}

async function _checkInbox(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  const task = queue.checkInbox(ctx.uid);
  if (task) return { inbox_empty: false, task, instant: true };

  if (args.wait) {
    const timeoutMs = args.timeout_ms || 30000;
    const waited = await queue.waitForTask(ctx.uid, timeoutMs);
    if (waited) return { inbox_empty: false, task: waited, instant: false };
    return { inbox_empty: true, waited_ms: Math.min(timeoutMs, 120000) };
  }

  return { inbox_empty: true };
}

async function _cancelTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = store.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  if (task.sender_uid !== ctx.uid) {
    // Not the sender — must be supervisor.
    const supErr = _requireSupervisor(ctx);
    if (supErr) return supErr;
    const r = queue.supervisorCancelTask(args.task_id);
    if (r.ok) return { ok: true };
    return { error: r.error };
  }
  const r = queue.cancelTask(args.task_id, ctx.uid);
  if (r.ok) return { ok: true };
  return { error: r.error };
}

async function _interruptTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = store.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  if (task.sender_uid !== ctx.uid) {
    const supErr = _requireSupervisor(ctx);
    if (supErr) return supErr;
    const r = queue.supervisorInterruptTask(args.task_id);
    if (r.ok) return { ok: true };
    return { error: r.error };
  }
  const r = queue.interruptTask(args.task_id, ctx.uid);
  if (r.ok) return { ok: true };
  return { error: r.error };
}

async function _respondTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const r = queue.respondTask(args.task_id, ctx.uid, args.result);
  if (r.ok) return { ok: true };
  return { error: r.error };
}

async function _listMyTasks(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  // Supervisor sees all workspace tasks.
  if (_getRole(ctx.uid) === 'supervisor') {
    const db = require('fs').readFileSync(store.DB_PATH, 'utf-8');
    const all = store.listMyTasks(ctx.uid);
    // Also collect tasks from other agents in same workspace.
    const myself = store.getAgent(ctx.uid);
    if (myself) {
      const allDb = JSON.parse(require('fs').readFileSync(store.DB_PATH, 'utf-8'));
      const wsTasks = Object.values(allDb.tasks || {}).filter(
        (t) => {
          const sender = allDb.agents?.[t.sender_uid];
          const receiver = allDb.agents?.[t.receiver_uid];
          return (sender && sender.workspace === myself.workspace) ||
                 (receiver && receiver.workspace === myself.workspace);
        }
      ).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { tasks: wsTasks, count: wsTasks.length, workspace: myself.workspace, supervisor_view: true };
    }
  }
  const tasks = queue.listMyTasks(ctx.uid);
  return { tasks, count: tasks.length };
}

async function _getTask(args, ctx) {
  const task = queue.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  return { task };
}

async function _broadcast(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const rateCheck = checkBroadcastRate(ctx.uid);
  if (!rateCheck.allowed) {
    return { error: `rate limited, max ${BROADCAST_LIMIT} broadcasts/min`, retryAfterMs: rateCheck.retryAfterMs };
  }

  const agents = registry.listAgentsInWorkspace(ctx.workspace);
  const uids = agents.map((a) => a.uid);
  const r = queue.broadcast(ctx.workspace, ctx.uid, sanitizeContent(args.message), uids);
  return { ok: r.ok, sent: r.sent, errors: r.errors };
}

// ── Sprint 5: Workflow Engine handlers ──────────────────────────────────

async function _defineWorkflow(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!ctx.workspace) return { error: 'not attached to a workspace' };
  return _workflowEngine().defineWorkflow(args.name, args.description, ctx.uid, ctx.workspace);
}

async function _addStage(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  return _workflowEngine().addStage(args.workflow_id, args, ctx.uid);
}

async function _addDependency(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  return _workflowEngine().addDependency(args.workflow_id, args.from_stage_id, args.to_stage_id, ctx.uid);
}

async function _activateWorkflow(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;

  // Build a dispatch function that uses agent-bus queue to send tasks.
  const dispatchFn = async (content, requiredCapabilities, workspace, workflowId, stageId) => {
    // Find a matching worker agent.
    const agents = registry.listAllAgentsInWorkspace(workspace);
    const caps = requiredCapabilities || [];
    let match;
    if (caps.length > 0) {
      match = agents.find((a) =>
        a.role !== 'supervisor' && caps.some((c) => (a.capabilities || []).includes(c)),
      );
    }
    if (!match) {
      match = agents.find((a) => a.role !== 'supervisor');
    }
    if (!match) return null;

    const taskId = store.genTaskId();
    const r = queue.sendTask({
      task_id: taskId,
      sender: { uid: ctx.uid, name: 'workflow', intro: 'Workflow dispatcher' },
      receiver_uid: match.uid,
      content: `[Workflow Stage]\n${content}`,
      priority: 'normal',
    });
    // Patch the task with workflow metadata.
    if (r.ok) {
      try {
        const db = JSON.parse(require('fs').readFileSync(store.DB_PATH, 'utf-8'));
        if (db.tasks[taskId]) {
          db.tasks[taskId].workflow_id = workflowId;
          db.tasks[taskId].stage_id = stageId;
          require('fs').writeFileSync(store.DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
        }
      } catch {}
    }
    return r.ok ? { task_id: taskId, assigned_agent_uid: match.uid } : null;
  };

  return _workflowEngine().activateWorkflow(args.workflow_id, ctx.uid, dispatchFn);
}

// ── Sprint 5: Decision System handlers ──────────────────────────────────

async function _requestDecision(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const myself = store.getAgent(ctx.uid);
  return _decisionSystem().createDecision({
    agent_uid: ctx.uid,
    agent_name: myself ? myself.name : '',
    workspace: ctx.workspace || '',
    title: args.title,
    content: args.content,
    urgent: args.urgent || false,
  });
}

async function _checkDecisions(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  return _decisionSystem().listDecisions({
    workspace: ctx.workspace || '',
    status: args.status || 'open',
    limit: args.limit || 20,
  });
}

// ── Sprint 5: Supervisor privilege handlers ─────────────────────────────

async function _assignTask(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  const myself = store.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };
  const receiver = store.getAgent(args.to_uid);
  if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
  if (receiver.workspace !== ctx.workspace) {
    return { error: 'cannot assign tasks across workspaces' };
  }
  const r = queue.sendTask({
    sender: { uid: ctx.uid, name: myself.name, intro: myself.intro },
    receiver_uid: args.to_uid,
    content: sanitizeContent(args.content),
    priority: args.priority || 'normal',
  });
  if (r.ok) return { ok: true, task: r.task, was_empty: r.was_empty };
  return { error: r.error };
}

async function _listAllAgents(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!ctx.workspace) return { error: 'not attached to a workspace' };
  const agents = registry.listAllAgentsInWorkspace(ctx.workspace);
  return {
    workspace: ctx.workspace,
    agents: agents.map((a) => ({
      uid: a.uid, name: a.name, intro: a.intro,
      role: a.role || 'worker', capabilities: a.capabilities || [],
      session_count: a.session_count || 0,
      last_seen_at: a.last_seen_at,
    })),
    self_uid: ctx.uid,
  };
}

async function _killWorker(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  const target = store.getAgent(args.target_uid);
  if (!target) return { error: 'agent not found' };
  if (target.workspace !== ctx.workspace) return { error: 'cannot kill agents in other workspaces' };
  const cancelled = queue.cancelAllTasksForAgent(args.target_uid);
  registry.forceDeregisterAgent(args.target_uid);
  return { ok: true, uid: args.target_uid, cancelled_tasks: cancelled };
}

// ── Sprint 5: BOOS Terminal listing handler ─────────────────────────────

async function _boosTerminalList(_args, _ctx) {
  let terminals = [];

  try {
    // Attempt to load webTerminal directly. This works when the agent-bus MCP
    // server runs in-process with BOOS (same Node.js instance). When running
    // as a standalone MCP server (separate process), webTerminal is not
    // available — fall back to persisted sessions as a cross-reference.
    const wt = require('../webTerminal');

    if (wt && typeof wt.list === 'function') {
      const rawList = wt.list(); // [{ id, meta: {cwd, pid, command}, attached, exitedAt, exitCode }]

      // Cross-reference with persisted sessions for cliId + workspace.
      let sessionMap = new Map();
      try {
        const persistedSessions = require('../persistedSessions');
        const sessions = await persistedSessions.loadAll();
        for (const s of sessions) {
          sessionMap.set(s.id, s);
        }
      } catch {}

      for (const t of rawList) {
        const persisted = sessionMap.get(t.id) || {};
        terminals.push({
          id: t.id,
          pid: t.meta?.pid || null,
          cliName: persisted.cliId || 'unknown',
          workspace: persisted.workspace || '',
          cwd: t.meta?.cwd || persisted.cwd || '',
          startedAt: t.meta?.startedAt || null,
          exitedAt: t.exitedAt || null,
        });
      }
    }
  } catch (err) {
    // TODO: DI injection — when agent-bus runs as a standalone MCP server,
    // webTerminal requires node-pty (native binary) and the BOOS server
    // process context. Two options for production:
    //   1. Pass webTerminal.list() as a dependency when creating the handler
    //      context (ctx.services.webTerminal).
    //   2. Expose terminal state via a shared JSON file (~/.boos/terminals.json)
    //      that both the BOOS server and MCP server can read.
    // For now, return an empty list with a hint so callers know this is
    // unavailable rather than silently returning nothing.
    return {
      terminals: [],
      count: 0,
      available: false,
      hint: 'webTerminal not available — agent-bus MCP server is running standalone. ' +
            'Terminal listing requires in-process access to the BOOS PTY pool. ' +
            'See TODO in lib/agentBus/handlers.js:_boosTerminalList for DI options.',
    };
  }

  return {
    terminals,
    count: terminals.length,
  };
}

// ── Sprint 6: Agent Wake-Up handler ──────────────────────────────────

async function _wakeAgent(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const target = store.getAgent(args.target_uid);
  if (!target) return { error: 'target agent not found: ' + args.target_uid };
  if (target.workspace !== ctx.workspace) return { error: 'cannot wake agents in other workspaces' };

  // Also send SSE notification to the target.
  try {
    const { notifyAgent } = require('./transport');
    notifyAgent(args.target_uid, 'notifications/agent_bus/wake', {
      from_uid: ctx.uid,
      from_name: (store.getAgent(ctx.uid) || {}).name || '',
      urgency: args.urgency || 'normal',
      message: args.message || '',
      timestamp: new Date().toISOString(),
    });
  } catch {}

  return notifications.wakeAgent(args.target_uid, {
    urgency: args.urgency || 'normal',
    message: args.message || '',
  });
}

module.exports = { dispatch };

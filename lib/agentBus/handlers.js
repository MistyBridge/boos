// MCP tool handler implementations.
//
// Adapted from agent-bus/mcp/handlers.js. Changed: require paths point to
// sibling modules in lib/agentBus/.
//
// ── TOCTOU Safety Audit (Sprint 17) ─────────────────────────────────────
// All mutating handlers delegate to store.js or queue.js, which use
// withFileLock for atomic read-validate-write. No TOCTOU races exist
// at the handler layer because handlers never directly mutate store data.
//
// | Handler        | Mutating? | TOCTOU-safe? | Mechanism               |
// |----------------|-----------|--------------|-------------------------|
// | register_agent | ✅        | ✅           | registry (store withFileLock) |
// | deregister_agent | ✅      | ✅           | store withFileLock      |
// | send_task      | ✅        | ✅           | queue.sendTask → store.insertTask (withFileLock) |
// | check_inbox    | ✅        | ✅           | queue.checkInbox → store.claimPendingTaskAsync (withFileLock) |
// | cancel_task    | ✅        | ✅           | queue.cancelTask → store.cancelTaskAtomic (withFileLock) |
// | interrupt_task | ✅        | ✅           | queue.interruptTask → store.interruptTaskAtomic (withFileLock) |
// | retry_task     | ✅        | ✅           | store.incrementTaskRetryCount (withFileLock) |
// | respond_task   | ✅        | ✅           | queue.respondTask → store.updateTaskStatus (withFileLock) |
// | broadcast      | ✅        | ✅           | queue.broadcast → store.insertTask (withFileLock) |
// | wake_agent     | read-only | N/A         | —                        |
// | list_agents    | read-only | N/A         | store._syncLoad (safe: read-only) |
// | list_my_tasks  | read-only | N/A         | queue.listMyTasks → store._syncLoad (safe: read-only) |
// | get_task       | read-only | N/A         | store.getTask → _syncLoad (safe: read-only) |
//
// ⚠️ NOTE: _listMyTasks supervisor path (L372-377) reads store.DB_PATH
// directly via readFileSync — bypasses store abstraction. Low risk
// because DB_PATH is hardcoded, but adds a second read (wasteful) and
// misses withFileLock ordering guarantees.
//
// ⚠️ NOTE: _broadcast (L399) does NOT require supervisor role. Any registered
// agent can broadcast to their workspace. Rate-limited to 10/min per agent
// via checkBroadcastRate() sliding window. Low risk with rate limiting.

'use strict';

const registry = require('./registry');
const queue = require('./queue');
const store = require('./store');
const notifications = require('./notifications');
const heartbeat = require('./heartbeat');

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

function _requirePM(ctx, project) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const agent = store.getAgent(ctx.uid);
  if (!agent) return { error: 'agent record not found — re-register' };
  if (store.isPMOf(agent, project)) return null;
  return { error: 'supervisor or project PM role required', role: agent.role || 'worker' };
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
    case 'retry_task':        return _retryTask(args, ctx);
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
    case 'wake_all':           return _wakeAll(args, ctx);
    // Sprint 9: Agent Peer Launch
    case 'launch_agent_session': return _launchAgentSession(args, ctx);
    // Sprint 10: File Lock + Knowledge Base
    case 'request_file_lock':  return _requestFileLock(args, ctx);
    case 'release_file_lock':  return _releaseFileLock(args, ctx);
    case 'list_file_locks':    return _listFileLocks(args, ctx);
    case 'update_knowledge':   return _updateKnowledge(args, ctx);
    case 'query_knowledge':    return _queryKnowledge(args, ctx);
    // Sprint 12 R15: Hard Constraints Engine
    case 'constraints_check':  return _constraintsCheck(args, ctx);
    case 'constraints_status': return _constraintsStatus(args, ctx);
    // Sprint 13: Root Agent tools
    case 'send_to_root':        return _sendToRoot(args, ctx);
    case 'check_root_response': return _checkRootResponse(args, ctx);
    // Sprint 8 Wave 1: PM Identity System
    case 'set_pm':             return _setPM(args, ctx);
    case 'assign_to_project':  return _assignToProject(args, ctx);
    default:                  return { error: 'unknown tool: ' + toolName };
  }
}

async function _register(args, ctx) {
  const { name, intro, workspace, role, capabilities, project } = args;
  if (!name || !workspace) {
    return { error: 'name and workspace are required' };
  }

  const result = await registry.registerAgent({ name, intro: intro || '', workspace, role, capabilities, project });

  if (!result.ok) return { error: result.error };

  ctx.uid = result.uid;
  ctx.workspace = workspace;
  await store.bindSession(ctx.sessionId, result.uid, workspace);

  // Sprint 16: write identity card — ALL fields MUST be non-null.
  // Hard constraint: if boos_session_id can't be resolved, use sentinel
  // '__pending__' (auto-healed on first _findSessionByUid call).
  try {
    const agent = store.getAgent(result.uid);
    let boosSessionId = await store.resolveBoosSessionForAgent(agent.name, agent.workspace);
    if (!boosSessionId) boosSessionId = '__pending__';

    const idFields = {
      agent_uid: result.uid,
      name: agent.name,
      workspace: agent.workspace,
      role: agent.role || 'worker',
      mcp_session_id: ctx.sessionId || '__pending__',
      boos_session_id: boosSessionId,
      cwd: '__pending__',
      pty_pid: 0,
      updated_at: new Date().toISOString(),
    };

    await store.upsertIdentity(result.uid, idFields);

    // Hard validation: reject if any field is still null.
    const validation = store.validateIdentity(store.getIdentity({ uid: result.uid }));
    if (!validation.ok) {
      console.error('[agent-bus] identity REGISTRATION FAILED for', agent.name + ':',
        'missing fields:', validation.missing.join(', '));
      // Don't reject — registration succeeded, identity will be auto-healed.
      // But log at ERROR level so operators can see the gap.
    }
  } catch (e) {
    console.warn('[agent-bus] identity card write failed for', result.uid, e.message);
  }

  // Sprint 13.3: schedule per-agent heartbeat timeout (event-driven, no polling).
  try { await heartbeat.scheduleNew(result.uid); } catch {}

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
  // Apply project-scope: unless supervisor, only see same-project or legacy agents.
  const myself = store.getAgent(ctx.uid);
  const projectFilter = (myself && myself.role !== 'supervisor') ? (myself.project || undefined) : undefined;
  const agents = registry.listAgentsInWorkspace(ctx.workspace, { project: projectFilter });
  // Sprint 8 #62: enrich with idle/busy state from collaborationLoop.
  const cl = require('./collaborationLoop');
  return {
    workspace: ctx.workspace,
    agents: agents.map((a) => {
      const state = cl.getAgentState(a.uid);
      return {
        uid: a.uid, name: a.name, intro: a.intro, project: a.project,
        status: state.state,        // 'idle' | 'busy'
        activeTasks: state.taskCount, // number of in_progress + pending tasks
      };
    }),
    self_uid: ctx.uid,
  };
}

async function _sendTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const myself = registry.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };

  // Validate receiver if specified directly (to_uid is optional when using capability routing).
  if (args.to_uid) {
    const receiver = registry.getAgent(args.to_uid);
    if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
    if (receiver.workspace !== ctx.workspace) {
      return { error: 'cannot send tasks across workspaces' };
    }
    // Project-scope check.
    if (myself.role !== 'supervisor' && myself.project) {
      if (receiver.project && receiver.project !== myself.project) {
        return { error: 'cannot send tasks across projects. You are in project "' + myself.project + '", receiver is in "' + receiver.project + '"' };
      }
    }
  }

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: myself.name, intro: myself.intro, workspace: myself.workspace },
    receiver_uid: args.to_uid || null,
    content: sanitizeContent(args.content),
    priority: args.priority || 'normal',
    reply_to: args.reply_to || null,
    required_capabilities: args.required_capabilities || [],
    metadata: args.metadata || null,
  });
  if (r.ok) return { ok: true, task: r.task, was_empty: r.was_empty };
  return { error: r.error };
}

async function _checkInbox(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  const task = await queue.checkInbox(ctx.uid);
  if (task) {
    // D2: cancel task timeout — agent has claimed it, no need to retry/escalate.
    try { require('./notifications').onTaskClaimed(task.task_id); } catch {}
    return { inbox_empty: false, task, instant: true };
  }

  if (args.wait) {
    const timeoutMs = args.timeout_ms || 30000;
    const waited = await queue.waitForTask(ctx.uid, timeoutMs);
    if (waited) {
      // D2: cancel task timeout — agent claimed it after waiting.
      try { require('./notifications').onTaskClaimed(waited.task_id); } catch {}
      return { inbox_empty: false, task: waited, instant: false };
    }
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
    const r = await queue.supervisorCancelTask(args.task_id);
    if (r.ok) return { ok: true };
    return { error: r.error };
  }
  const r = await queue.cancelTask(args.task_id, ctx.uid);
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
    const r = await queue.supervisorInterruptTask(args.task_id);
    if (r.ok) {
      // Sprint 10 R11: recycle to pending + notify receiver to drop work.
      await _recycleInterruptedTask(task);
      return { ok: true };
    }
    return { error: r.error };
  }
  const r = await queue.interruptTask(args.task_id, ctx.uid);
  if (r.ok) {
    // Sprint 10 R11: recycle to pending + notify receiver to drop work.
    await _recycleInterruptedTask(task);
    return { ok: true };
  }
  return { error: r.error };
}

// Sprint 10 R11: after interrupt, recycle task to pending (no retry penalty)
// and notify the receiver to stop working on it via SSE + PTY.
async function _recycleInterruptedTask(task) {
  try {
    // Reset to pending — this is a preemption, not a failure.
    await store.updateTaskStatus(task.task_id, 'pending', null);

    // Notify receiver to drop current work.
    const receiver = store.getAgent(task.receiver_uid);
    if (receiver) {
      try {
        const notifications = require('./notifications');
        await notifications._onTaskInterrupted(task.task_id, task.receiver_uid,
          receiver.name, task.content);
      } catch {}
    }

    // Emit so the task is re-routed (may go to a different idle agent).
    queue.inboxEvents.emit('task_available', task.receiver_uid);
  } catch {}
}

async function _retryTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const r = queue.retryTask(args.task_id, ctx.uid);
  if (r.ok) return { ok: true, retry_count: r.retry_count, remaining: r.remaining };
  return { error: r.error };
}

async function _respondTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const r = await queue.respondTask(args.task_id, ctx.uid, args.result, args.metadata || null);
  if (r.ok) return { ok: true };
  return { error: r.error };
}

async function _listMyTasks(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  // Supervisor sees all workspace tasks.
  // Sprint 17: use store.listAllTasksInWorkspace() instead of raw
  // readFileSync(store.DB_PATH) — respects store abstraction + file locking.
  if (_getRole(ctx.uid) === 'supervisor') {
    const myself = store.getAgent(ctx.uid);
    if (myself) {
      const wsTasks = store.listAllTasksInWorkspace(myself.workspace);
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

  let agents = registry.listAgentsInWorkspace(ctx.workspace);

  // Scope filter: 'project' limits broadcast to same-project agents only.
  if (args.scope === 'project') {
    const myself = store.getAgent(ctx.uid);
    if (myself && myself.project) {
      agents = agents.filter((a) => !a.project || a.project === myself.project);
    }
  }

  const uids = agents.map((a) => a.uid);
  const r = await queue.broadcast(ctx.workspace, ctx.uid, sanitizeContent(args.message), uids);
  return { ok: r.ok, sent: r.sent, errors: r.errors };
}

// ── Sprint 8 Wave 1: PM Identity System ────────────────────────────────

async function _setPM(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!args.target_uid) return { error: 'target_uid is required' };
  const projects = Array.isArray(args.projects) ? args.projects : [];
  return registry.setProjectPM(args.target_uid, projects, ctx.uid);
}

async function _assignToProject(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (!args.target_uid || !args.project) return { error: 'target_uid and project are required' };
  return registry.assignToProject(args.target_uid, args.project, ctx.uid);
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
    const r = await queue.sendTask({
      task_id: taskId,
      sender: { uid: ctx.uid, name: 'workflow', intro: 'Workflow dispatcher' },
      receiver_uid: match.uid,
      content: `[Workflow Stage]\n${content}`,
      priority: 'normal',
    });
    // Attach workflow metadata atomically (no TOCTOU race).
    if (r.ok) {
      try { await store.setTaskWorkflowMeta(taskId, workflowId, stageId); } catch {}
    }
    return r.ok ? { task_id: taskId, assigned_agent_uid: match.uid } : null;
  };

  return _workflowEngine().activateWorkflow(args.workflow_id, ctx.uid, dispatchFn);
}

// ── Sprint 5: Decision System handlers ──────────────────────────────────

async function _requestDecision(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  // Sprint 12 R15: hard constraints engine — filter auto-decidable requests.
  try {
    const constraints = require('./constraints');
    const evalResult = constraints.evaluate('request_decision', {
      content: args.content || '',
      agent_uid: ctx.uid,
      task_id: args.blocking_task_id || null,
      retry_count: 0,
      error_type: null,
    });
    if (!evalResult.pass) {
      // C1/C3: auto-decide — no decision card created.
      if (evalResult.auto_action === 'reject') {
        return {
          ok: true,
          auto_decided: true,
          rule: evalResult.rule,
          reason: evalResult.reason,
          hint: '此决策被硬约束引擎自动处理（' + evalResult.rule + '），无需人类介入。',
        };
      }
      // C2: auto-retry — agent should retry directly.
      if (evalResult.auto_action === 'retry') {
        return {
          ok: true,
          auto_decided: true,
          rule: evalResult.rule,
          reason: evalResult.reason,
          hint: '错误可自动重试（' + evalResult.rule + '），agent 应直接重试而非请求决策。',
        };
      }
    }
    // Pass merge_group to decision system for C6 batch merging.
    if (evalResult.merge_group) {
      args._merge_group = evalResult.merge_group;
    }
  } catch {}

  const myself = store.getAgent(ctx.uid);
  const result = _decisionSystem().createDecision({
    agent_uid: ctx.uid,
    agent_name: myself ? myself.name : '',
    workspace: ctx.workspace || '',
    title: args.title,
    content: args.content,
    urgent: args.urgent || false,
    blocking_task_id: args.blocking_task_id || null,
    merge_group: args._merge_group || null,
  });

  // Sprint 9: auto-block the calling task if agent passed blocking_task_id.
  if (result.ok && args.blocking_task_id) {
    try {
      const blockResult = await queue.blockTask(args.blocking_task_id, '等待人类决策: ' + (args.title || result.decision_id));
      result.task_blocked = blockResult.ok;
      if (!blockResult.ok) result.block_error = blockResult.error;
    } catch (e) {
      result.task_blocked = false;
      result.block_error = e.message;
    }
  }

  return result;
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
  // Allow supervisor OR project PM.
  const myself = store.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };
  const receiver = store.getAgent(args.to_uid);
  if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
  if (receiver.workspace !== ctx.workspace) {
    return { error: 'cannot assign tasks across workspaces' };
  }
  // Permission: supervisor (all) or PM of receiver's project.
  const targetProject = receiver.project;
  const pmErr = _requirePM(ctx, targetProject);
  if (pmErr) return pmErr;

  const r = await queue.sendTask({
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
    // webTerminal unavailable — agent-bus running standalone (without BOOS).
    // In practice this only triggers in test/CI; production agent-bus is
    // always embedded in the BOOS server process.
    return {
      terminals: [],
      count: 0,
      available: false,
      hint: 'webTerminal unavailable — requires in-process BOOS PTY pool.',
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

  // Build message with optional context.
  let msg = args.message || '';
  if (args.context) {
    msg = msg ? msg + '\n' + args.context : args.context;
  }
  const result = await notifications.wakeAgent(args.target_uid, {
    urgency: args.urgency || 'normal',
    message: msg,
  });
  // Sprint 13.4: surface task delivery count in response.
  if (result.ok && result.tasks_delivered > 0) {
    result.hint = `已向 ${result.agent_name} 投递 ${result.tasks_delivered} 个待处理任务`;
  }
  return result;
}

// ── Sprint 8 Wave 4: Wake All ────────────────────────────────────────

async function _wakeAll(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const agents = registry.listAgentsInWorkspace(ctx.workspace);
  const excludeSelf = args.exclude_self !== false;
  const results = [];

  for (const agent of agents) {
    if (excludeSelf && agent.uid === ctx.uid) continue;
    try {
      const r = await notifications.wakeAgent(agent.uid, {
        urgency: args.urgency || 'normal',
        message: args.message || '全员通知 — 请检查收件箱。',
      });
      results.push({ uid: agent.uid, name: agent.name, ok: r.ok });
    } catch {
      results.push({ uid: agent.uid, name: agent.name, ok: false, error: 'failed' });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { ok: true, total: results.length, succeeded, results };
}

// ── Sprint 9: Agent Peer Launch handler ──────────────────────────────────

async function _launchAgentSession(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  const ws = args.workspace || ctx.workspace;
  if (!ws) return { error: 'not attached to a workspace' };

  // 1. Find agent in registry by name + workspace.
  const agent = store.findAgentByNameWs(args.agent_name, ws);
  if (!agent) {
    const all = store.listAgentsInWorkspace(ws);
    return { error: 'agent "' + args.agent_name + '" not found in workspace "' + ws + '". Available: ' + all.map((a) => a.name).join(', ') };
  }

  // 2. Find existing BOOS session for this agent.
  const persistedSessions = require('../persistedSessions');
  const webTerminalMod = require('../webTerminal');
  const allSessions = await persistedSessions.loadAll();

  // Sprint 14: use IdentityResolver for canonical BOOS session lookup.
  // Falls back to transport session ID + name-based matching if unavailable.
  let existing = null;
  try {
    const { getResolver } = require('../../identityResolver');
    const boosId = getResolver().canonical(agent.uid);
    if (boosId) {
      existing = allSessions.find((s) => s.id === boosId && s.status !== 'deleted');
    }
  } catch {}
  // Fallback: transport session ID from agent-bus sessions table.
  if (!existing) {
    const agentSessionId = store.getSessionByAgentUid(agent.uid);
    if (agentSessionId) {
      existing = allSessions.find((s) => s.id === agentSessionId && s.status !== 'deleted');
    }
  }
  // Fallback: name-based heuristic matching.
  if (!existing) {
    const safeName = agent.name.replace(/[<>:"/\\|?*]/g, '_');
    existing = allSessions.find((s) =>
      (s.workspace === safeName || require('path').basename(s.cwd || '') === safeName) &&
      s.status !== 'deleted',
    );
  }

  // 3. Already running — no-op.
  if (existing && existing.status === 'running') {
    const term = webTerminalMod.get(existing.id);
    if (term && !term.exitedAt) {
      // Sprint 13: update identity card with current BOOS session.
      try { await store.upsertIdentity(agent.uid, { boos_session_id: existing.id, cwd: existing.cwd, pty_pid: term.meta?.pid || null }); } catch {}
      return {
        ok: true, session_id: existing.id, status: 'already_running',
        pid: term.meta && term.meta.pid, agent_uid: agent.uid,
        hint: 'Agent ' + agent.name + ' session ' + existing.id + ' is already running.',
      };
    }
  }

  // 4. Resume or create via spawnSessionRecord.
  const { getSpawnSessionRecord } = require('../sessionHelpers');
  const spawnFn = getSpawnSessionRecord();
  if (!spawnFn) {
    return { error: 'spawnSessionRecord not available — BOOS server has not fully initialized yet' };
  }

  const { loadConfig, getRuntimePort } = require('../config');
  const { findCliById } = require('../cliHelpers');
  const cfg = await loadConfig();
  const cliId = cfg.defaultCliId || (cfg.clis && cfg.clis[0] && cfg.clis[0].id);
  const cli = findCliById(cfg, cliId);
  if (!cli) return { error: 'No CLI configured. Add one in Configure → CLIs.' };

  if (existing) {
    // Dead PTY or exited session — resume.
    try {
      const launched = await spawnFn({ record: existing, cli, cfg, body: {}, resume: true });
      // Sprint 13: update identity card after resume.
      try { await store.upsertIdentity(agent.uid, { boos_session_id: existing.id, cwd: existing.cwd, pty_pid: launched?.pid || null }); } catch {}
      return {
        ok: true, session_id: existing.id, status: 'resumed',
        pid: launched.pid, agent_uid: agent.uid,
        hint: 'Session ' + existing.id + ' resumed for ' + agent.name + '.',
      };
    } catch (e) {
      return { error: 'Failed to resume session ' + existing.id + ': ' + e.message };
    }
  }

  // 4.5 Sprint 18: check for pre-configured agent directory.
  // Some agents (HR Agent, manually pre-configured agents) already have
  // .claude/CLAUDE.md + .mcp.json set up. Use that directory directly
  // instead of creating a blank workspace.
  // Priority: HR Agent → BOOS/HR/ ; other agents → BOOS/claudes/<name>/
  const pathMod = require('path');
  const fsPromises = require('node:fs/promises');
  const projectRoot = pathMod.resolve(__dirname, '..', '..');
  const candidateDirs = [];
  if (agent.name === 'HR Agent') {
    candidateDirs.push(pathMod.join(projectRoot, 'HR'));
  }
  candidateDirs.push(pathMod.join(projectRoot, 'claudes', agent.name));
  for (const agentDir of candidateDirs) {
    try {
      const claudeMd = pathMod.join(agentDir, '.claude', 'CLAUDE.md');
      await fsPromises.access(claudeMd);
      // Directory exists and is pre-configured — use it directly.
      const record = await persistedSessions.create({
        cliId: cli.id,
        cwd: agentDir,
        workspace: agent.name,
        repos: [],
        folderId: null,
        title: agent.name,
      });
      // Don't overwrite existing .mcp.json — the pre-configured one is authoritative.
      try {
        const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
        try { await store.upsertIdentity(agent.uid, { boos_session_id: record.id, cwd: agentDir, pty_pid: launched?.pid || null }); } catch {}
        return {
          ok: true, session_id: record.id, status: 'launched',
          pid: launched.pid, agent_uid: agent.uid,
          hint: 'Pre-configured session launched for ' + agent.name + ' from ' + agentDir,
        };
      } catch (e) {
        // Skip this candidate on spawn failure, try next.
      }
    } catch {} // ENOENT — skip this candidate
  }

  // 5. No existing session — create a fresh workspace + session.
  const { listWorkspaces, findOrCreateWorkspace } = require('../workspace');
  const busyPaths = allSessions
    .filter((s) => s.status === 'running' && s.cwd)
    .map((s) => s.cwd);

  const existingWs = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
  let workspace = existingWs.find((w) => w.name === agent.name);

  if (!workspace) {
    const r = await findOrCreateWorkspace({
      workDir: cfg.workDir, repos: cfg.repos, busyPaths, requireUnused: true,
    });
    workspace = r.workspace;
  }

  const launchCwd = workspace.path;
  const record = await persistedSessions.create({
    cliId: cli.id,
    cwd: launchCwd,
    workspace: workspace.name,
    repos: (cfg.repos || []).filter((r) => r.defaultSelected).map((r) => r.name),
    folderId: null,
    title: agent.name,
  });

  // Auto-inject agent-bus MCP config + sandbox-aware filesystem.
  const mcpPath = require('path').join(launchCwd, '.mcp.json');
  try {
    let existingMcp = { mcpServers: {} };
    try {
      const raw = await require('node:fs/promises').readFile(mcpPath, 'utf-8');
      existingMcp = JSON.parse(raw);
    } catch {}
    // Sandbox-aware filesystem config with agent role check.
    const sandbox = require('../sandbox');
    const fsConfig = await sandbox.getFilesystemMcpConfig({
      folderId: record.folderId,
      agentUid: agent.uid,
    });
    const merged = {
      ...existingMcp,
      mcpServers: {
        ...(existingMcp.mcpServers || {}),
        'agent-bus': {
          command: 'node',
          args: [require('path').join(require('os').homedir(), '.boos', 'mcp-proxy.js')],
        },
        filesystem: fsConfig,
      },
    };
    await require('node:fs/promises').mkdir(require('path').dirname(mcpPath), { recursive: true });
    await require('node:fs/promises').writeFile(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch {}

  try {
    const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
    // Sprint 13: update identity card after launch.
    try { await store.upsertIdentity(agent.uid, { boos_session_id: record.id, cwd: launchCwd, pty_pid: launched?.pid || null }); } catch {}
    return {
      ok: true, session_id: record.id, status: 'launched',
      pid: launched.pid, agent_uid: agent.uid,
      hint: 'New BOOS session created for ' + agent.name + ' — ' + record.id,
    };
  } catch (e) {
    await persistedSessions.markExited(record.id, null);
    return { error: 'Failed to launch session: ' + e.message };
  }
}

// ── Sprint 10 R13: File Lock Handlers ─────────────────────────────────

async function _requestFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  const agent = store.getAgent(ctx.uid);
  return fl.requestLock(ctx.uid, agent ? agent.name : ctx.uid, args.file_path);
}

async function _releaseFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.releaseLock(ctx.uid, args.file_path);
}

async function _listFileLocks(_args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.listLocks();
}

// ── Sprint 10 R12: Knowledge Base Handlers ──────────────────────────

async function _updateKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  const agent = store.getAgent(ctx.uid);
  return kb.writeEntry(args.path, args.content, {
    append: args.append,
    author: agent ? agent.name : ctx.uid,
  });
}

async function _queryKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  if (args.path) return kb.readEntry(args.path);
  if (args.query) return kb.search(args.query);
  return kb.listSection(args.section || null);
}

// ── Sprint 12 R15: Hard Constraints Engine Handlers ──────────────────

async function _constraintsCheck(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return constraints.checkLimits(ctx.uid);
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

async function _constraintsStatus(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return {
      workspace: ctx.workspace || 'boos',
      agents: constraints.workspaceStatus(ctx.workspace || 'boos'),
    };
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

// ── Sprint 13: Root Agent tools ──────────────────────────────────────────

async function _sendToRoot(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const content = String(args.content || '').slice(0, 8192);
  if (!content.trim()) return { error: 'content is required' };

  const agent = store.getAgent(ctx.uid);
  const ROOT_UID = store.ROOT_UID;

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: agent?.name || 'unknown', intro: agent?.intro || '', workspace: ctx.workspace || '' },
    receiver_uid: ROOT_UID,
    content,
    priority: args.priority || 'normal',
    reply_to: args.reply_to || undefined,
  });

  if (!r.ok) return { error: r.error };
  return { ok: true, task_id: r.task_id, hint: 'Message sent to BOOS Root. Human will respond via Decision Area UI.' };
}

async function _checkRootResponse(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const ROOT_UID = store.ROOT_UID;
  const allTasks = store.listMyTasks(ctx.uid);
  const responses = allTasks.filter((t) =>
    t.sender_uid === ROOT_UID &&
    t.status === 'completed' &&
    (!args.decision_id || t.reply_to === args.decision_id),
  );
  return {
    pending: responses.length,
    responses: responses.slice(0, 20).map((t) => ({
      task_id: t.task_id,
      reply_to: t.reply_to,
      content: t.result || t.content,
      created_at: t.created_at,
      updated_at: t.updated_at,
    })),
  };
}

// Sprint 13: extracted launch helper — used by notifications.js for wake-before-deliver.
// Retries identity lookup + session spawn; returns session record or null.
async function _internalLaunchAgentSession(agentUid, agentName, agentWorkspace) {
  try {
    const agent = store.getAgent(agentUid) || store.findAgentByNameWs(agentName, agentWorkspace);
    if (!agent) return null;

    const persistedSessions = require('../persistedSessions');
    const webTerminalMod = require('../webTerminal');
    const allSessions = await persistedSessions.loadAll();

    // Sprint 14: IdentityResolver for canonical BOOS session lookup.
    // Falls back to raw identity card + name-based matching.
    let existing = null;
    try {
      const { getResolver } = require('../../identityResolver');
      const boosId = getResolver().canonical(agent.uid);
      if (boosId) {
        existing = allSessions.find((s) => s.id === boosId);
      }
    } catch {}
    // Fallback: identity card by UID.
    if (!existing) {
      const identity = store.getIdentity({ uid: agent.uid });
      if (identity?.boos_session_id) {
        existing = allSessions.find((s) => s.id === identity.boos_session_id);
      }
    }

    // Fall back to name-based matching.
    if (!existing) {
      const safeName = agent.name.replace(/[<>:"/\\|?*]/g, '_');
      existing = allSessions.find((s) =>
        (s.workspace === safeName || require('path').basename(s.cwd || '') === safeName) &&
        s.status !== 'deleted',
      );
    }

    // Already running — verify PTY is alive.
    if (existing && existing.status === 'running') {
      const term = webTerminalMod.get(existing.id);
      if (term && !term.exitedAt) return existing;
    }

    // Try to resume/create.
    const { getSpawnSessionRecord } = require('../sessionHelpers');
    const spawnFn = getSpawnSessionRecord();
    if (!spawnFn) return null;

    const { loadConfig, getRuntimePort } = require('../config');
    const { findCliById } = require('../cliHelpers');
    const cfg = await loadConfig();
    const cliId = cfg.defaultCliId || (cfg.clis && cfg.clis[0] && cfg.clis[0].id);
    const cli = findCliById(cfg, cliId);
    if (!cli) return null;

    if (existing) {
      const launched = await spawnFn({ record: existing, cli, cfg, body: {}, resume: true });
      try { await store.upsertIdentity(agent.uid, { boos_session_id: existing.id, pty_pid: launched?.pid || null }); } catch {}
      return existing;
    }

    // Create new workspace + session.
    const { listWorkspaces, findOrCreateWorkspace } = require('../workspace');
    const busyPaths = allSessions.filter((s) => s.status === 'running' && s.cwd).map((s) => s.cwd);
    const existingWs = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
    let workspace = existingWs.find((w) => w.name === agent.name);
    if (!workspace) {
      const r = await findOrCreateWorkspace({ workDir: cfg.workDir, repos: cfg.repos, busyPaths, requireUnused: true });
      workspace = r.workspace;
    }
    const launchCwd = workspace.path;
    const record = await persistedSessions.create({
      cliId: cli.id, cwd: launchCwd, workspace: workspace.name,
      repos: (cfg.repos || []).filter((r) => r.defaultSelected).map((r) => r.name),
      folderId: null, title: agent.name,
    });
    const launched = await spawnFn({ record, cli, cfg, body: {}, resume: false, extraCliArgs: [] });
    try { await store.upsertIdentity(agent.uid, { boos_session_id: record.id, cwd: launchCwd, pty_pid: launched?.pid || null }); } catch {}
    return record;
  } catch (e) {
    console.warn('[agent-bus] internalLaunchAgentSession failed for', agentName, e.message);
    return null;
  }
}

module.exports = { dispatch, _internalLaunchAgentSession };

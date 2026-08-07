// MCP tool handler dispatch + core messaging handlers.
//
// All mutating handlers delegate to store.js or queue.js which use
// withFileLock for atomic read-validate-write. No TOCTOU races exist
// at the handler layer.
//
// Split across 4 modules (Sprint 31 refactor — ≤500 lines each):
//   handlers.js        — dispatch() + core messaging (this file)
//   handlersDag.js     — DAG task system handlers
//   handlersAdmin.js   — supervisor / PM / workflow / decision / wake
//   handlersSession.js — session launch / file locks / knowledge / constraints

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


const registry = require('./registry');
const queue = require('./queue');
const store = require('./store');
const notifications = require('./notifications');
const heartbeat = require('./heartbeat');
const auth = require('./auth');
const cacheStore = require('./cacheStore');   // Sprint 41: externalized letter content
const ptyInjectionQueue = require('./ptyInjectionQueue');

// Sub-module dispatchers — loaded at require time for dispatch() switch.
const handlersDag = require('./handlersDag');
const handlersAdmin = require('./handlersAdmin');
const handlersSession = require('./handlersSession');
const boosMcpTools = require('./boosMcpTools');

// ── role helpers (thin wrappers over unified auth module) ──────────────

function _getRole(uid) {
  return auth.getRole(uid);
}
function _requireSupervisor(ctx) {
  return auth.requireSupervisor(ctx);
}
function _requirePM(ctx, project) {
  return auth.requireProjectPM(ctx, project);
}

// ── content sanitization ─────────────────────────────────────────────────
// Strip ANSI escape sequences and control characters (except \n, \t, \r).

const CONTENT_MAX_BYTES = 64 * 1024;

function sanitizeContent(str) {
  if (typeof str !== 'string') return '';
  return str.slice(0, CONTENT_MAX_BYTES)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── broadcast rate limiting ──────────────────────────────────────────────

const BROADCAST_WINDOW_MS = 60_000;
const BROADCAST_LIMIT = 10;
const _broadcastTimestamps = new Map();

function checkBroadcastRate(uid) {
  const now = Date.now();
  const timestamps = _broadcastTimestamps.get(uid) || [];
  const recent = timestamps.filter((t) => now - t < BROADCAST_WINDOW_MS);
  if (recent.length >= BROADCAST_LIMIT) {
    return { allowed: false, retryAfterMs: BROADCAST_WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  _broadcastTimestamps.set(uid, recent);
  return { allowed: true };
}

// ── dispatch ─────────────────────────────────────────────────────────────

async function dispatch(toolName, args, ctx) {
  // Sprint 42: ctx.uid is set by transport from x-boos-cli-session-id header —
  // the ONLY authoritative UID source. Here we only fill missing workspace
  // by looking up the agent registry with the header UID.
  // Never override ctx.uid from stored session mappings.
  if (ctx.uid && !ctx.workspace && toolName !== 'register_agent') {
    const agent = store.getAgent(ctx.uid);
    if (agent) {
      ctx.workspace = agent.workspace;
    }
  }
  // Legacy fallback: no header UID at all (old clients). Resolve from stored
  // MCP session → UID mapping as last resort.
  if (!ctx.uid && toolName !== 'register_agent') {
    const auto = store.autoResolveIdentity(ctx.sessionId);
    if (auto) {
      ctx.uid = auto.uid;
      ctx.workspace = auto.identity?.workspace || null;
      console.log('[agent-bus] auto-resolved (legacy, no header)', auto.identity?.name || auto.uid.slice(-8),
        'from MCP session', ctx.sessionId?.slice(-12));
    }
  }

  switch (toolName) {
    // ── Core messaging ────────────────────────────────────────────────
    case 'register_agent':    return _register(args, ctx);
    case 'deregister_agent':  return _deregister(args, ctx);
    case 'list_agents':       return _listAgents(args, ctx);
    case 'send_task':         return _sendTask(args, ctx);
    case 'check_inbox':       return _checkInbox(args, ctx);
    case 'cancel_task':       return _cancelTask(args, ctx);
    case 'interrupt_task':    return _interruptTask(args, ctx);
    case 'retry_task':        return _retryTask(args, ctx);
    case 'respond_task':      return _respondTask(args, ctx);
    case 'settle_task':       return _settleTask(args, ctx);
    case 'list_my_tasks':     return _listMyTasks(args, ctx);
    case 'get_task':          return _getTask(args, ctx);
    case 'get_archived_task': return _getArchivedTask(args, ctx);
    case 'get_task_content':  return _getTaskContent(args, ctx);   // Sprint 41: read externalized letter content
    case 'broadcast':         return _broadcast(args, ctx);

    // ── Admin / supervisor ───────────────────────────────────────────
    case 'set_pm':             return handlersAdmin._setPM(args, ctx);
    case 'assign_to_project':  return handlersAdmin._assignToProject(args, ctx);
    case 'define_workflow':    return handlersAdmin._defineWorkflow(args, ctx);
    case 'add_stage':          return handlersAdmin._addStage(args, ctx);
    case 'add_dependency':     return handlersAdmin._addDependency(args, ctx);
    case 'activate_workflow':  return handlersAdmin._activateWorkflow(args, ctx);
    case 'request_decision':   return handlersAdmin._requestDecision(args, ctx);
    case 'assign_task':        return handlersAdmin._assignTask(args, ctx);
    case 'list_all_agents':    return handlersAdmin._listAllAgents(args, ctx);
    case 'list_agent_cards':   return handlersAdmin._listAgentCards(args, ctx);
    case 'team_matrix':        return handlersAdmin._teamMatrix(args, ctx);
    case 'kill_worker':        return handlersAdmin._killWorker(args, ctx);
    case 'purge_workspace':    return handlersAdmin._purgeWorkspace(args, ctx);
    case 'boos_terminal_list': return handlersAdmin._boosTerminalList(args, ctx);
    case 'wake_agent':         return handlersAdmin._wakeAgent(args, ctx);
    case 'wake_all':           return handlersAdmin._wakeAll(args, ctx);

    // ── Session / infra ──────────────────────────────────────────────
    case 'request_file_lock':    return handlersSession._requestFileLock(args, ctx);
    case 'release_file_lock':    return handlersSession._releaseFileLock(args, ctx);
    case 'list_file_locks':      return handlersSession._listFileLocks(args, ctx);
    case 'update_knowledge':     return handlersSession._updateKnowledge(args, ctx);
    case 'query_knowledge':      return handlersSession._queryKnowledge(args, ctx);
    case 'constraints_check':    return handlersSession._constraintsCheck(args, ctx);
    case 'constraints_status':   return handlersSession._constraintsStatus(args, ctx);
    case 'send_to_root':         return handlersSession._sendToRoot(args, ctx);

    // ── DAG task system ──────────────────────────────────────────────
    case 'dag_create':         return handlersDag._dagCreate(args, ctx);
    case 'dag_add_task':       return handlersDag._dagAddTask(args, ctx);
    case 'dag_activate':       return handlersDag._dagActivate(args, ctx);
    case 'dag_status':         return handlersDag._dagStatus(args, ctx);
    case 'dag_cancel':         return handlersDag._dagCancel(args, ctx);
    case 'dag_submit_task':    return handlersDag._dagSubmitTask(args, ctx);
    case 'dag_approve_task':   return handlersDag._dagApproveTask(args, ctx);
    case 'dag_reject_task':    return handlersDag._dagRejectTask(args, ctx);
    case 'dag_my_tasks':       return handlersDag._dagMyTasks(args, ctx);
    case 'dag_reassign_task':  return handlersDag._dagReassignTask(args, ctx);
    case 'dag_list':           return handlersDag._dagList(args, ctx);
    case 'dag_decompose':           return handlersDag._dagDecompose(args, ctx);
    case 'dag_suggest_assignments': return handlersDag._dagSuggestAssignments(args, ctx);
    case 'dag_sleep_agent':    return handlersDag._dagSleepAgent(args, ctx);
    case 'dag_wake_agent':     return handlersDag._dagWakeAgent(args, ctx);

    // ── Sprint 37: Goal system ────────────────────────────────────────
    case 'goal_create':          return handlersDag._goalCreate(args, ctx);
    case 'goal_list':            return handlersDag._goalList(args, ctx);
    case 'goal_status':          return handlersDag._goalStatus(args, ctx);
    case 'goal_update':          return handlersDag._goalUpdate(args, ctx);
    case 'goal_archive':         return handlersDag._goalArchive(args, ctx);
    case 'goal_start':           return handlersDag._goalStart(args, ctx);
    case 'goal_pause':           return handlersDag._goalPause(args, ctx);

    // ── Sprint 37: Review questions ───────────────────────────────────
    case 'dag_add_questions':    return handlersDag._dagAddQuestions(args, ctx);
    case 'dag_answer_question':  return handlersDag._dagAnswerQuestion(args, ctx);

    // ── Sprint 37: Proposal system ────────────────────────────────────
    case 'dag_propose_task':     return handlersDag._dagProposeTask(args, ctx);
    case 'dag_approve_proposal': return handlersDag._dagApproveProposal(args, ctx);
    case 'dag_reject_proposal':  return handlersDag._dagRejectProposal(args, ctx);

    // ── Sprint 37: Runtime adjustment ─────────────────────────────────
    case 'dag_rearrange':        return handlersDag._dagRearrange(args, ctx);
    case 'dag_force_modify':     return handlersDag._dagForceModify(args, ctx);
    case 'dag_partial_rollback': return handlersDag._dagPartialRollback(args, ctx);

    // ── Sprint 37: Conflict escalation ────────────────────────────────
    case 'dag_escalate_conflict': return handlersDag._dagEscalateConflict(args, ctx);

    // ── BOOS MCP Server tools ─────────────────────────────────────────
    case 'boos.list_sessions':   return boosMcpTools._listSessions(args, ctx);
    case 'boos.get_session':     return boosMcpTools._getSession(args, ctx);
    case 'boos.list_workspaces': return boosMcpTools._listWorkspaces(args, ctx);

    default: return { error: 'unknown tool: ' + toolName };
  }
}

// ── Core messaging handlers ──────────────────────────────────────────────

async function _register(args, ctx) {
  const { name, intro, workspace, role, capabilities, project, cli_session_id } = args;
  if (!name || !workspace) return { error: 'name and workspace are required' };

  // Sprint 42: identity auto-detection — cli_session_id is OPTIONAL now.
  // BOOS transport binds ctx.uid from the x-boos-cli-session-id header
  // (BOOS_CLI_SESSION_ID env, injected per session). Manual override is
  // still honoured for exotic setups.
  const cliSessionId = cli_session_id || ctx.uid || null;
  const result = await registry.registerAgent({
    name, intro: intro || '', workspace, role, capabilities, project,
    cliSessionId,
  });
  if (!result.ok) return { error: result.error };

  ctx.uid = result.uid;
  ctx.workspace = workspace;
  await store.bindSession(ctx.sessionId, result.uid, workspace);

  try {
    await store.writeIdentity(result.uid, {
      name: args.name, workspace, role: role || 'worker',
      mcp_session_id: ctx.sessionId,
      cli_session_id: cliSessionId || undefined,
    });
    // Sync routing fields to PG adapter (authoritative source).
    try {
      const adapter = require('../identityAdapter');
      await adapter.upsert(result.uid, {
        name: args.name, workspace, role: role || 'worker',
        mcp_session_id: ctx.sessionId,
      });
    } catch { /* PG optional */ }
  } catch (e) { console.warn('[agent-bus] identity card write failed for', result.uid, e.message); }

  try {  await heartbeat.scheduleNew(result.uid);  } catch (e) { errReport.report("handlers", "scheduleNew", e); }

  // Auto-deliver pending tasks on reconnect: wake the agent so they get
  // the check_inbox command injected into their PTY. Without this, agents
  // that reconnect after BOOS restart would have pending tasks sitting
  // in their queue with no notification.
  const pending = result.pending_tasks || 0;
  if (result.reconnected && pending > 0) {
    try {
      const wakeResult = await notifications.wakeAgent(result.uid, {
        urgency: 'urgent',
        sender_name: 'Agent-Bus',
        message: `Welcome back! You have ${pending} pending task(s).`,
      });
      console.log('[agent-bus] auto-wake on reconnect:', result.uid.slice(-8),
        `(${pending} pending) → SSE:${wakeResult.sse_delivered} PTY:${wakeResult.pty_delivered}`);
    } catch (e) { errReport.report("handlers", "log", e); }
    // Drain PTY injection queue — agent is likely idle after reconnect.
    setImmediate(() => ptyInjectionQueue.releaseAndDrain(result.uid));
  }

  return {
    ok: true, uid: result.uid, role: role || 'worker',
    reconnected: result.reconnected || false, pending_tasks: pending,
    hint: result.reconnected
      ? 'Reconnected. You have ' + pending + ' pending task(s). Call check_inbox to fetch them.'
      : 'Registered as ' + result.uid + '. Your identity is persistent across sessions.',
  };
}

async function _deregister(args, ctx) {
  if (!ctx.uid) return { error: 'not registered yet' };

  // Release all file locks held by this agent — auto-grants to waiters.
  try {
    const fl = require('./fileLock');
    const lockResult = fl.releaseAllForAgent(ctx.uid);
    if (lockResult.released > 0) {
      console.log('[agent-bus] deregister: released', lockResult.released, 'file locks for', ctx.uid.slice(-8));
    }
  } catch (e) { errReport.report("handlers", "log", e); }

  // Clear PTY injection queue for this agent.
  try {  ptyInjectionQueue.clearQueue(ctx.uid);  } catch (e) { errReport.report("handlers", "clearQueue", e); }

  await store.unbindSession(ctx.sessionId);
  const r = registry.deregisterAgent(ctx.uid);
  ctx.uid = null;
  ctx.workspace = null;
  return { ok: true, existed: r.existed, file_locks_released: 0 };
}

async function _listAgents(args, ctx) {
  if (!ctx.workspace) return { error: 'not attached to a workspace — register_agent first' };
  const myself = store.getAgent(ctx.uid);
  const projectFilter = (myself && myself.role !== 'supervisor') ? (myself.project || undefined) : undefined;
  const agents = registry.listAgentsInWorkspace(ctx.workspace, { project: projectFilter });
  const cl = require('./collaborationLoop');
  const errReport = require("../errorReport");
  const agentStates = await Promise.all(agents.map(async (a) => {
    const state = await cl.getAgentState(a.uid);
    return { uid: a.uid, name: a.name, intro: a.intro, project: a.project, status: state.state, activeTasks: state.taskCount };
  }));
  return {
    workspace: ctx.workspace,
    agents: agentStates,
    self_uid: ctx.uid,
  };
}

async function _sendTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const myself = registry.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };

  const msgType = args.message_type || 'request';
  if (!['request', 'response'].includes(msgType)) {
    return { error: 'message_type must be "request" or "response"' };
  }

  if (msgType === 'response') {
    if (!args.reply_to) return { error: 'message_type "response" requires reply_to (the task being replied to)' };
    const parent = store.getTask(args.reply_to);
    if (!parent) return { error: 'reply_to task not found: ' + args.reply_to };
    const root = _findRootTask(args.reply_to);
    if (!args.to_uid) args.to_uid = parent.sender_uid;
    if (args.to_uid !== root.sender_uid && args.to_uid !== root.receiver_uid) {
      return { error: 'response chain must terminate at the original requester. Valid targets: ' + root.sender_uid + ' or ' + root.receiver_uid };
    }
  }

  if (args.to_uid) {
    const receiver = registry.getAgent(args.to_uid);
    if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
    if (receiver.workspace !== ctx.workspace) return { error: 'cannot send tasks across workspaces' };
    if (myself.role !== 'supervisor' && myself.project) {
      if (receiver.project && receiver.project !== myself.project) {
        return { error: 'cannot send tasks across projects' };
      }
    }
  }

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: myself.name, intro: myself.intro, workspace: myself.workspace },
    receiver_uid: args.to_uid || null, content: sanitizeContent(args.content),
    priority: args.priority || 'normal', reply_to: args.reply_to || null,
    message_type: msgType, required_capabilities: args.required_capabilities || [],
    metadata: args.metadata || null,
  });

  if (r.ok) {
    const receiverUid = r.task?.receiver_uid;
    if (receiverUid) {
      try {
        await notifications.wakeAgent(receiverUid, {
          urgency: args.priority === 'high' ? 'urgent' : 'normal',
          sender_name: myself.name, sender_uid: ctx.uid, task_count: 1,
        });
      } catch (e) { errReport.report("handlers", "wakeAgent", e); }
    }
    return { ok: true, sender: ctx.uid, task: r.task, was_empty: r.was_empty, auto_wake: !!receiverUid };
  }
  return { error: r.error };
}

async function _checkInbox(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = await queue.checkInbox(ctx.uid);
  const source = 'check_inbox[' + ctx.uid + ']';
  if (task) {
    try {  require('./notifications').onTaskClaimed(task.task_id);  } catch (e) { errReport.report("handlers", "require", e); }
    return { inbox_empty: false, source, receiver: ctx.uid, task };
  }
  return { inbox_empty: true, source, receiver: ctx.uid };
}

async function _cancelTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = store.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  if (task.sender_uid !== ctx.uid) {
    const supErr = _requireSupervisor(ctx);
    if (supErr) return supErr;
    const r = await queue.supervisorCancelTask(args.task_id);
    return r.ok ? { ok: true } : { error: r.error };
  }
  const r = await queue.cancelTask(args.task_id, ctx.uid);
  return r.ok ? { ok: true } : { error: r.error };
}

async function _interruptTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = store.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  const isOwner = task.sender_uid === ctx.uid;
  if (!isOwner) {
    const supErr = _requireSupervisor(ctx);
    if (supErr) return supErr;
  }
  const r = isOwner
    ? await queue.interruptTask(args.task_id, ctx.uid)
    : await queue.supervisorInterruptTask(args.task_id);
  if (r.ok) { await _recycleInterruptedTask(task); return { ok: true }; }
  return { error: r.error };
}

async function _recycleInterruptedTask(task) {
  try {
    await store.updateTaskStatus(task.task_id, 'pending', null);
    const receiver = store.getAgent(task.receiver_uid);
    if (receiver) {
      try {  await notifications._onTaskInterrupted(task.task_id, task.receiver_uid, receiver.name, task.content);  } catch (e) { errReport.report("handlers", "_onTaskInterrupted", e); }
    }
    queue.inboxEvents.emit('task_available', task.receiver_uid);
  } catch (e) { errReport.report("handlers", "emit", e); }
}

function _findRootTask(taskId, maxDepth = 20) {
  let current = store.getTask(taskId);
  let depth = 0;
  while (current && current.reply_to && depth < maxDepth) {
    const parent = store.getTask(current.reply_to);
    if (!parent) break;
    current = parent;
    depth++;
  }
  return current;
}

async function _retryTask(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;
  const isSupervisor = auth.getRole(ctx.uid) === 'supervisor';
  const r = await queue.retryTask(args.task_id, ctx.uid, isSupervisor);
  return r.ok ? { ok: true, retry_count: r.retry_count, remaining: r.remaining } : { error: r.error };
}

async function _respondTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const r = await queue.respondTask(args.task_id, ctx.uid, args.result, args.metadata || null);
  if (r.ok) {
    r.responder = ctx.uid;
    r.task_id = args.task_id;
    return r;
  }
  return { error: r.error };
}

// ── Sprint 37: PM settlement ──────────────────────────────────────────

async function _settleTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const r = await queue.settleTask(args.task_id, ctx.uid, args.action, args.feedback || '');
  if (r.ok) { r.approver = ctx.uid; r.task_id = args.task_id; return r; }
  return { error: r.error };
}

async function _listMyTasks(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (_getRole(ctx.uid) === 'supervisor') {
    const myself = store.getAgent(ctx.uid);
    if (myself) {
      // Sprint 36: read from inbox files, not stale agent-bus.json.
      const wsTasks = await queue.listAllTasksInWorkspace(myself.workspace);
      return { tasks: wsTasks, count: wsTasks.length, workspace: myself.workspace, supervisor_view: true };
    }
  }
  const tasks = await queue.listMyTasks(ctx.uid);
  return { tasks, count: tasks.length };
}

async function _getTask(args, ctx) {
  // Sprint 36: require registration + restrict to participants (or supervisor).
  // Active tasks only — searches inbox (pending + in_progress).
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const task = queue.getTask(args.task_id);
  if (!task) return { error: 'task not found in active inboxes (may be archived — use get_archived_task)' };

  const role = auth.getRole(ctx.uid);
  if (role !== 'supervisor' && !auth.isParticipant(ctx.uid, task)) {
    return { error: 'access denied: you are neither sender nor receiver of this task' };
  }
  return { task };
}

async function _getArchivedTask(args, ctx) {
  // Sprint 36: query completed/cancelled/exhausted tasks from archive JSONL.
  // Same auth model as get_task: registered + participant or supervisor.
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const task = await queue.getArchivedTask(args.task_id);
  if (!task) return { error: 'archived task not found: ' + args.task_id };

  const role = auth.getRole(ctx.uid);
  if (role !== 'supervisor' && !auth.isParticipant(ctx.uid, task)) {
    return { error: 'access denied: you are neither sender nor receiver of this task' };
  }
  return { task, source: 'archive' };
}

async function _getTaskContent(args, ctx) {
  // Sprint 41: read externalized letter content on demand.
  // Long task bodies / submission results / feedback live in per-task cache
  // files — letters carry only a summary + ref. This tool returns the full
  // text WITHOUT re-echoing the entire task object.
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const taskId = args.task_id;
  const kind = args.kind || 'content';
  if (!taskId) return { error: 'task_id is required' };

  // Participants (or supervisor) only — same auth model as get_task.
  const task = queue.getTask(taskId);
  if (!task) {
    // Fall back to archive lookup so settled-task content stays readable.
    const archived = await queue.getArchivedTask(taskId);
    if (!archived) return { error: 'task not found' };
    const role = auth.getRole(ctx.uid);
    if (role !== 'supervisor' && !auth.isParticipant(ctx.uid, archived)) {
      return { error: 'access denied: you are neither sender nor receiver of this task' };
    }
    const full = cacheStore.read(taskId, kind);
    return full != null
      ? { task_id: taskId, kind, content: full, source: 'archive' }
      : { task_id: taskId, kind, content: archived.submitted_result || archived.content || '', source: 'archive-inline' };
  }

  const role = auth.getRole(ctx.uid);
  if (role !== 'supervisor' && !auth.isParticipant(ctx.uid, task)) {
    return { error: 'access denied: you are neither sender nor receiver of this task' };
  }

  // Kind-specific resolution: prefer cache file, fall back to inline fields.
  let content = cacheStore.read(taskId, kind);
  let source = 'cache';
  if (content == null) {
    if (kind === 'result') { content = task.submitted_result || task.result || ''; source = 'inline'; }
    else if (kind === 'feedback') { content = task.metadata?.feedback || ''; source = 'inline'; }
    else { content = task.content || ''; source = 'inline'; }
  }
  return { task_id: taskId, kind, content, source };
}

async function _broadcast(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const rateCheck = checkBroadcastRate(ctx.uid);
  if (!rateCheck.allowed) {
    return { error: `rate limited, max ${BROADCAST_LIMIT} broadcasts/min`, retryAfterMs: rateCheck.retryAfterMs };
  }

  let agents = registry.listAgentsInWorkspace(ctx.workspace);
  if (args.scope === 'project') {
    const myself = store.getAgent(ctx.uid);
    if (myself && myself.project) {
      agents = agents.filter((a) => !a.project || a.project === myself.project);
    }
  }

  const uids = agents.map((a) => a.uid);
  const r = await queue.broadcast(ctx.workspace, ctx.uid, sanitizeContent(args.message), uids);

  if (r.ok && uids.length > 0) {
    const myself = store.getAgent(ctx.uid);
    Promise.all(uids.map((uid) =>
      notifications.wakeAgent(uid, { urgency: 'normal', sender_name: myself?.name || '系统', sender_uid: ctx.uid }).catch(() => {})
    )).catch(() => {});
  }

  return { ok: r.ok, sent: r.sent, errors: r.errors };
}

module.exports = { dispatch };

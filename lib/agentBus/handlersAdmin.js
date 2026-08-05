// Supervisor / PM / workflow / decision / wake MCP handlers.
//
// Imported by handlers.js dispatch() for admin-level switch cases.

'use strict';

const store = require('./store');
const registry = require('./registry');
const queue = require('./queue');
const notifications = require('./notifications');
const auth = require('./auth');

// ── role helpers (thin wrappers over unified auth module) ──────────────

function _getRole(uid) { return auth.getRole(uid); }
function _requireSupervisor(ctx) { return auth.requireSupervisor(ctx); }
function _requirePM(ctx, project) { return auth.requireProjectPM(ctx, project); }

// ── PM Identity System ──────────────────────────────────────────────────

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

// ── Workflow Engine ─────────────────────────────────────────────────────

function _workflowEngine() { return require('../workflowEngine'); }
function _decisionSystem() { return require('../decisionSystem'); }

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

  const dispatchFn = async (content, requiredCapabilities, workspace, workflowId, stageId) => {
    const agents = registry.listAllAgentsInWorkspace(workspace);
    const caps = requiredCapabilities || [];
    let match;
    if (caps.length > 0) {
      match = agents.find((a) =>
        a.role !== 'supervisor' && caps.some((c) => (a.capabilities || []).includes(c)),
      );
    }
    if (!match) match = agents.find((a) => a.role !== 'supervisor');
    if (!match) return null;

    const taskId = store.genTaskId();
    const r = await queue.sendTask({
      task_id: taskId,
      sender: { uid: ctx.uid, name: 'workflow', intro: 'Workflow dispatcher' },
      receiver_uid: match.uid,
      content: `[Workflow Stage]\n${content}`,
      priority: 'normal',
    });
    if (r.ok) {
      try { await store.setTaskWorkflowMeta(taskId, workflowId, stageId); } catch {}
    }
    return r.ok ? { task_id: taskId, assigned_agent_uid: match.uid } : null;
  };

  return _workflowEngine().activateWorkflow(args.workflow_id, ctx.uid, dispatchFn);
}

// ── Decision System ─────────────────────────────────────────────────────

async function _requestDecision(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };

  try {
    const constraints = require('./constraints');
    const evalResult = constraints.evaluate('request_decision', {
      content: args.content || '', agent_uid: ctx.uid,
      task_id: args.blocking_task_id || null, retry_count: args.retry_count || 0,
      error_type: args.error_type || null,
    });
    if (!evalResult.pass) {
      if (evalResult.auto_action === 'reject') {
        return { ok: true, auto_decided: true, rule: evalResult.rule, reason: evalResult.reason,
          hint: '此决策被硬约束引擎自动处理（' + evalResult.rule + '），无需人类介入。' };
      }
      if (evalResult.auto_action === 'retry') {
        return { ok: true, auto_decided: true, rule: evalResult.rule, reason: evalResult.reason,
          hint: '错误可自动重试（' + evalResult.rule + '），agent 应直接重试而非请求决策。' };
      }
    }
    if (evalResult.merge_group) args._merge_group = evalResult.merge_group;
  } catch {}

  const myself = store.getAgent(ctx.uid);

  // ── Sprint 37: Workers escalate to PM, not decision area ──
  // Only supervisors (PM/PMO) can create decision cards.
  // Workers → PM inbox; PM evaluates → decision area if needed.
  const isSupervisor = myself && (myself.role === 'supervisor' || myself.role === 'pmo');

  if (!isSupervisor) {
    return await _escalateToPM(args, ctx, myself);
  }

  // Supervisor: create decision card directly in decision area.
  const result = _decisionSystem().createDecision({
    agent_uid: ctx.uid, agent_name: myself ? myself.name : '',
    workspace: ctx.workspace || '', title: args.title, content: args.content,
    urgent: args.urgent || false, blocking_task_id: args.blocking_task_id || null,
    merge_group: args._merge_group || null,
  });

  if (result.ok && args.blocking_task_id) {
    try {
      const blockResult = await queue.blockTask(args.blocking_task_id,
        '等待人类决策: ' + (args.title || result.decision_id));
      result.task_blocked = blockResult.ok;
      if (!blockResult.ok) result.block_error = blockResult.error;
    } catch (e) { result.task_blocked = false; result.block_error = e.message; }
  }
  return result;
}

// ── Sprint 37: Worker escalation → PM inbox ─────────────────────────────

async function _escalateToPM(args, ctx, myself) {
  const agentName = myself ? myself.name : ctx.uid.slice(-8);

  // Resolve PM for this workspace/project.
  let pmUid = null;
  try {
    const goalStore = require('./goalStore');
    pmUid = goalStore.resolveProjectPM(ctx.workspace || 'boos', ctx.project || 'boos-core');
  } catch {}

  if (!pmUid) {
    // Fallback: find any supervisor in workspace.
    const all = store.listAllAgents();
    const pm = all.find((a) => a.workspace === (ctx.workspace || 'boos') && a.role === 'supervisor');
    pmUid = pm ? pm.uid : null;
  }

  if (!pmUid) {
    // No PM found — create decision card as last resort.
    const result = _decisionSystem().createDecision({
      agent_uid: ctx.uid, agent_name: agentName,
      workspace: ctx.workspace || '', title: args.title || 'Agent 升级请求',
      content: `**${agentName}** 请求决策，但未找到 PM。\n\n${args.content || ''}`,
      urgent: args.urgent || false, blocking_task_id: args.blocking_task_id || null,
    });
    return { ok: true, ...result, routed_to: 'decision_area', reason: 'no_pm_found' };
  }

  // Route to PM inbox.
  const title = args.title || 'Agent 决策请求';
  const content = [
    '## Agent 升级请求',
    '',
    '**发起者**: ' + agentName + ' (`' + ctx.uid + '`)',
    (args.blocking_task_id ? '**阻塞任务**: `' + args.blocking_task_id + '`' : ''),
    args.urgent ? '**⚠️ 紧急**' : '',
    '',
    '### 问题描述',
    args.content || '(无内容)',
    '',
    '---',
    '*此消息由 agent-bus constraints 引擎自动路由到 PM inbox。*',
    '*PM 评估后：能决策则 respond_task 回复 agent，无法决策则调用 request_decision 上报决策区。*',
  ].filter(Boolean).join('\n');

  try {
    const r = await queue.sendTask({
      sender: { uid: ctx.uid, name: agentName, intro: myself?.intro || 'Agent 升级请求' },
      receiver_uid: pmUid,
      content,
      priority: args.urgent ? 'high' : 'normal',
      reply_to: null,
    });

    if (r.ok) {
      // Also block the associated task if needed.
      let taskBlocked = false;
      if (args.blocking_task_id) {
        try {
          const blockResult = await queue.blockTask(args.blocking_task_id,
            '等待 PM 决策: ' + (title || 'Agent 升级'));
          taskBlocked = blockResult.ok;
        } catch {}
      }

      return {
        ok: true,
        routed_to: 'pm_inbox',
        pm_uid: pmUid,
        task_id: r.task?.task_id,
        task_blocked: taskBlocked,
        hint: '已上报 PM（' + pmUid.slice(-8) + '）。PM 评估后会回复你。PM 超时 30min 会自动升级到决策区。',
      };
    }

    return { ok: false, error: 'failed to route to PM: ' + (r.error || 'unknown'), routed_to: 'pm_inbox' };
  } catch (e) {
    return { ok: false, error: 'PM routing error: ' + e.message };
  }
}

// ── Supervisor Privileges ───────────────────────────────────────────────

async function _assignTask(args, ctx) {
  const myself = store.getAgent(ctx.uid);
  if (!myself) return { error: 'agent record not found — re-register' };
  const receiver = store.getAgent(args.to_uid);
  if (!receiver) return { error: 'agent "' + args.to_uid + '" not found' };
  if (receiver.workspace !== ctx.workspace) {
    return { error: 'cannot assign tasks across workspaces' };
  }
  const targetProject = receiver.project;
  const pmErr = _requirePM(ctx, targetProject);
  if (pmErr) return pmErr;

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: myself.name, intro: myself.intro },
    receiver_uid: args.to_uid,
    content: args.content,
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
      session_count: a.session_count || 0, last_seen_at: a.last_seen_at,
    })),
    self_uid: ctx.uid,
  };
}

async function _killWorker(args, ctx) {
  // Sprint 38 shutdown blacklist: kill_worker requires root role.
  // No agent (not even supervisor/PM) can deregister or kill other agents
  // through MCP.  Session management is only available through the BOOS
  // frontend and REST API (both shutdown-token protected).
  const rootErr = auth.requireRoot(ctx);
  if (rootErr) return rootErr;
  const target = store.getAgent(args.target_uid);
  if (!target) return { error: 'agent not found' };
  if (target.workspace !== ctx.workspace) return { error: 'cannot kill agents in other workspaces' };

  // Release all file locks held by this agent — auto-grants to waiters.
  let fileLocksReleased = 0;
  try {
    const fl = require('./fileLock');
    const lockResult = fl.releaseAllForAgent(args.target_uid);
    fileLocksReleased = lockResult.released;
  } catch {}

  const cancelled = queue.cancelAllTasksForAgent(args.target_uid);
  registry.forceDeregisterAgent(args.target_uid);
  return { ok: true, uid: args.target_uid, cancelled_tasks: cancelled, file_locks_released: fileLocksReleased };
}

// ── Agent Identity Cards ────────────────────────────────────────────────

async function _listAgentCards(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const includeStale = args.include_stale === true;
  const agents = includeStale
    ? registry.listAllAgentsInWorkspace(ctx.workspace)
    : registry.listAgentsInWorkspace(ctx.workspace);

  const cl = require('./collaborationLoop');
  const ptyByUid = {};
  try {
    const { getResolver } = require('../identityResolver');
    const resolver = getResolver();
    for (const a of agents) {
      const boosId = await resolver.canonical(a.uid);
      if (boosId) ptyByUid[a.uid] = boosId;
    }
  } catch {}

  let livePtyIds = new Set();
  try {
    const wt = require('../webTerminal');
    const tlist = wt.list ? wt.list() : [];
    livePtyIds = new Set(tlist.filter((t) => !t.exitedAt).map((t) => t.id));
  } catch {}

  const cards = agents.map((a) => {
    const state = cl.getAgentState(a.uid);
    const sessionId = ptyByUid[a.uid] || null;
    const hasLivePty = sessionId ? livePtyIds.has(sessionId) : false;

    // DAG enrichment.
    let dagExecutorCount = 0, dagReviewerCount = 0, dagEscalatedCount = 0;
    try {
      const dagStore = require('./dagStore');
      const myTasks = dagStore.getMyDagTasks(a.uid);
      dagExecutorCount = (myTasks.as_executor || []).filter((t) => t.status !== 'cancelled' && t.status !== 'approved').length;
      dagReviewerCount = (myTasks.as_reviewer || []).filter((t) => t.status === 'submitted').length;
      dagEscalatedCount = (myTasks.as_executor || []).filter((t) => t.status === 'escalated').length +
        (myTasks.as_reviewer || []).filter((t) => t.status === 'escalated').length;
    } catch {}

    return {
      uid: a.uid, name: a.name, intro: a.intro || '',
      role: a.role || 'worker', workspace: a.workspace, project: a.project || null,
      pm_of: a.pm_of || [], capabilities: a.capabilities || [],
      status: state.state, active_tasks: state.taskCount,
      has_pty: hasLivePty, session_id: sessionId,
      registered_at: a.registered_at || null, last_seen_at: a.last_seen_at || null,
      dag: {
        as_executor: dagExecutorCount,
        as_reviewer: dagReviewerCount,
        escalated: dagEscalatedCount,
      },
    };
  });

  return { workspace: ctx.workspace, cards, count: cards.length, self_uid: ctx.uid };
}

// ── Team Matrix (Sprint 32) ── PM-only capability/DAG/health cross-reference.
async function _teamMatrix(args, ctx) {
  const supErr = _requireSupervisor(ctx);
  if (supErr) return supErr;
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  const ws = args.workspace || ctx.workspace;
  const agents = registry.listAllAgentsInWorkspace(ws);
  const storeMod = require('./store');
  const cl = require('./collaborationLoop');

  // Live PTY detection.
  let livePtyIds = new Set();
  try { const wt = require('../webTerminal'); livePtyIds = new Set((wt.list ? wt.list() : []).filter((t) => !t.exitedAt).map((t) => t.id)); } catch {}

  // Agent rows with DAG enrichment.
  const rows = agents.map((a) => {
    const state = cl.getAgentState(a.uid);
    const tasks = storeMod.listActiveTasks(a.uid);
    const hasPty = livePtyIds.has(a.uid) || false;

    let dagAsExecutor = 0;
    let dagAsReviewer = 0;
    let dagEscalated = 0;
    try {
      const dagStore = require('./dagStore');
      const my = dagStore.getMyDagTasks(a.uid);
      dagAsExecutor = (my.as_executor || []).filter((t) => t.status !== 'cancelled' && t.status !== 'approved').length;
      dagAsReviewer = (my.as_reviewer || []).filter((t) => t.status === 'submitted').length;
      dagEscalated = (my.as_executor || []).concat(my.as_reviewer || []).filter((t) => t.status === 'escalated').length;
    } catch {}

    return {
      uid: a.uid, name: a.name,
      role: a.role || 'worker',
      capabilities: a.capabilities || [],
      status: state.state,
      active_tasks: tasks.length,
      has_pty: hasPty,
      last_seen_at: a.last_seen_at || null,
      dag_executor_of: dagAsExecutor,
      dag_reviewer_of: dagAsReviewer,
      dag_escalated: dagEscalated,
    };
  });

  // Capability coverage map.
  const capMap = new Map(); // capability → [agent names]
  for (const r of rows) {
    for (const cap of r.capabilities) {
      if (!capMap.has(cap)) capMap.set(cap, []);
      capMap.get(cap).push(r.name);
    }
  }
  const coverage = [];
  for (const [cap, names] of capMap) {
    coverage.push({ capability: cap, agents: names, count: names.length });
  }
  coverage.sort((a, b) => b.count - a.count);

  // Uncovered capabilities (fuzzy match against known capability keywords).
  const capNames = [...capMap.keys()];
  const uncovered = ['frontend','backend','testing','security','devops','mcp','sse','documentation','css','html','preact']
    .filter((w) => !capNames.some((c) => c.includes(w)));

  // Role distribution.
  const roles = { supervisor: 0, worker: 0, pmo: 0, root: 0 };
  for (const r of rows) {
    const role = r.role || 'worker';
    roles[role] = (roles[role] || 0) + 1;
  }

  // Status distribution.
  const statuses = { idle: 0, busy: 0, off: 0 };
  for (const r of rows) {
    const s = r.status || 'off';
    statuses[s] = (statuses[s] || 0) + 1;
  }

  // Escalated tasks summary.
  let escalatedTasks = [];
  try {
    const dagStore = require('./dagStore');
    const dags = dagStore.listDags(ws);
    for (const dag of dags) {
      const tasks = dagStore.getTasksByStatus(dag.dag_id, 'escalated');
      for (const t of tasks) {
        escalatedTasks.push({
          task_id: t.task_id, dag_id: t.dag_id, title: t.title,
          executor_uid: t.executor_uid, reviewer_uid: t.reviewer_uid,
          retry_count: t.retry_count || 0,
        });
      }
    }
  } catch {}

  // PM health.
  const pmRows = rows.filter((r) => r.role === 'supervisor');
  const pmHealth = pmRows.map((pm) => {
    const now = Date.now();
    const lastSeen = pm.last_seen_at ? new Date(pm.last_seen_at).getTime() : 0;
    const minutesSinceSeen = Math.round((now - lastSeen) / 60000);
    return {
      uid: pm.uid, name: pm.name,
      responsive: minutesSinceSeen < 10,
      minutes_since_last_seen: minutesSinceSeen,
    };
  });

  return {
    ok: true,
    workspace: ws,
    timestamp: new Date().toISOString(),
    summary: {
      total_agents: rows.length,
      roles,
      statuses,
      escalated_tasks: escalatedTasks.length,
      uncovered_capabilities: uncovered,
    },
    agents: rows,
    capability_coverage: coverage,
    escalated_tasks: escalatedTasks,
    pm_health: pmHealth,
    self_uid: ctx.uid,
  };
}

// ── Terminal Listing ────────────────────────────────────────────────────

async function _boosTerminalList(_args, ctx) {
  // Sprint 36: require registration. Filter terminals to same workspace.
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  let terminals = [];
  try {
    const wt = require('../webTerminal');
    if (wt && typeof wt.list === 'function') {
      const rawList = wt.list();
      let sessionMap = new Map();
      try {
        const persistedSessions = require('../persistedSessions');
        const sessions = await persistedSessions.loadAll();
        for (const s of sessions) sessionMap.set(s.id, s);
      } catch {}
      for (const t of rawList) {
        const persisted = sessionMap.get(t.id) || {};
        // Sprint 38 fix: Drop workspace filter — session.workspace is a
        // BOOS UI folder name (e.g. "可靠性工程师-A2"), not the agent-bus
        // workspace ("boos"). The two never match, causing the filter to
        // reject every terminal. Registration gate above is sufficient.
        terminals.push({
          id: t.id, pid: t.meta?.pid || null,
          cliName: persisted.cliId || 'unknown',
          workspace: persisted.workspace || '',
          cwd: t.meta?.cwd || persisted.cwd || '',
          startedAt: t.meta?.startedAt || null,
          exitedAt: t.exitedAt || null,
        });
      }
    }
  } catch (err) {
    return { terminals: [], count: 0, available: false,
      hint: 'webTerminal unavailable — requires in-process BOOS PTY pool.' };
  }
  return { terminals, count: terminals.length };
}

// ── Wake Agent ──────────────────────────────────────────────────────────

async function _wakeAgent(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  if (!ctx.workspace) return { error: 'not attached to a workspace' };

  // Sprint 31: any registered agent can wake another agent in the same workspace.
  // No supervisor requirement — peer-to-peer wake is a core collaboration primitive.
  const target = store.getAgent(args.target_uid);
  if (!target) return { error: 'target agent not found: ' + args.target_uid };
  if (target.workspace !== ctx.workspace) return { error: 'cannot wake agents in other workspaces' };

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

  let msg = args.message || '';
  if (args.context) {
    msg = msg ? msg + '\n' + args.context : args.context;
  }
  const result = await notifications.wakeAgent(args.target_uid, {
    urgency: args.urgency || 'normal',
    message: msg,
  });
  if (result.ok && result.tasks_delivered > 0) {
    result.hint = `已向 ${result.agent_name} 投递 ${result.tasks_delivered} 个待处理任务`;
  }
  return result;
}

async function _wakeAll(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
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

module.exports = {
  _setPM, _assignToProject,
  _defineWorkflow, _addStage, _addDependency, _activateWorkflow,
  _requestDecision,
  _assignTask, _listAllAgents, _killWorker,
  _listAgentCards, _teamMatrix, _boosTerminalList,
  _wakeAgent, _wakeAll,
};

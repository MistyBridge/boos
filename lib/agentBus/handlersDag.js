// DAG task system MCP handlers — Sprint 31.
//
// Handles all dag_* MCP tools and pmo_poll.  Imported by handlers.js
// dispatch() for DAG-related switch cases.
//
// Permission model (hardcoded):
//   dag_create / dag_add_task / dag_activate / dag_cancel / dag_reassign_task → PM/PMO only
//   dag_submit_task → executor only
//   dag_approve_task / dag_reject_task → reviewer only
//   dag_my_tasks / dag_status / dag_list → any registered agent
//   dag_sleep_agent / dag_wake_agent → PM/PMO only
//   pmo_poll → PMO only

'use strict';

function _requirePMorPMO(ctx) {
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);
  if (!agent || (agent.role !== 'supervisor' && agent.role !== 'pmo')) {
    throw new Error('PM (supervisor) or PMO role required');
  }
  return agent;
}

async function _dagCreate(args, ctx) {
  _requirePMorPMO(ctx);
  const dagStore = require('./dagStore');
  const dag = await dagStore.createDag({
    title: args.title,
    description: args.description,
    workspace: args.workspace || ctx.workspace || 'boos',
    createdBy: ctx.uid,
  });
  return { ok: true, dag };
}

async function _dagAddTask(args, ctx) {
  _requirePMorPMO(ctx);
  const dagStore = require('./dagStore');
  const task = await dagStore.addTask(args.dag_id, args);
  return { ok: true, task };
}

async function _dagActivate(args, ctx) {
  _requirePMorPMO(ctx);
  const dagEngine = require('./dagEngine');
  return dagEngine.activateWithReport(args.dag_id);
}

async function _dagStatus(args, ctx) {
  const dagStore = require('./dagStore');
  const dag = dagStore.getDag(args.dag_id);
  if (!dag) return { error: `DAG ${args.dag_id} not found` };
  const summary = dagStore.getDagSummary(args.dag_id);
  return { ok: true, dag, summary };
}

async function _dagCancel(args, ctx) {
  _requirePMorPMO(ctx);
  const dagStore = require('./dagStore');
  await dagStore.cancelDag(args.dag_id, args.reason);
  return { ok: true, dag_id: args.dag_id, status: 'cancelled' };
}

async function _dagSubmitTask(args, ctx) {
  const taskSystem = require('./taskSystem');
  return taskSystem.submitTask(args.task_id, ctx.uid, {
    content: args.content,
    attachments: args.attachments,
  });
}

async function _dagApproveTask(args, ctx) {
  const taskSystem = require('./taskSystem');
  const result = await taskSystem.approveTask(args.task_id, ctx.uid, {
    comment: args.comment,
  });
  // Post-approval cascade: notify newly-ready executors via dagEngine.
  if (result.ok) {
    try {
      const dagEngine = require('./dagEngine');
      const cascade = await dagEngine.afterTaskApproved(args.task_id);
      if (cascade && cascade.newly_ready_tasks && cascade.newly_ready_tasks.length > 0) {
        result.newly_ready_tasks = cascade.newly_ready_tasks;
      }
      if (cascade && cascade.dag_completed) {
        result.dag_completed = true;
        await dagEngine.afterDagCompleted(cascade.dag_id);
      }
    } catch {}
  }
  return result;
}

async function _dagRejectTask(args, ctx) {
  const taskSystem = require('./taskSystem');
  const result = await taskSystem.rejectTask(args.task_id, ctx.uid, {
    comment: args.comment,
  });
  // If escalated (max retries), notify PM via dagEngine.
  if (result.ok && result.escalated) {
    try {
      const dagEngine = require('./dagEngine');
      await dagEngine.onTaskEscalated(args.task_id);
    } catch {}
  }
  return result;
}

async function _dagMyTasks(args, ctx) {
  const dagStore = require('./dagStore');
  const tasks = dagStore.getMyDagTasks(ctx.uid);
  return { ok: true, ...tasks };
}

async function _dagReassignTask(args, ctx) {
  _requirePMorPMO(ctx);
  const taskSystem = require('./taskSystem');
  return taskSystem.reassignDagTask(args.task_id, ctx.uid, {
    newExecutorUid: args.new_executor_uid,
    newReviewerUid: args.new_reviewer_uid,
  });
}

async function _dagList(args, ctx) {
  const dagStore = require('./dagStore');
  const ws = args.workspace || ctx.workspace || 'boos';
  const dags = dagStore.listDags(ws);
  const enriched = dags.map((d) => ({
    ...d,
    summary: dagStore.getDagSummary(d.dag_id),
  }));
  return { ok: true, workspace: ws, dags: enriched, count: enriched.length };
}

async function _dagSleepAgent(args, ctx) {
  const store = require('./store');
  const caller = store.getAgent(ctx.uid);
  const target = store.getAgent(args.target_uid);
  if (!target) return { error: `agent ${args.target_uid} not found` };

  const isPM = caller && caller.role === 'supervisor';
  const isPMO = caller && caller.role === 'pmo';
  if (!isPM && !isPMO) return { error: 'sleep requires PM or PMO role' };
  if (isPM && target.role === 'supervisor') {
    return { error: 'PM cannot sleep another supervisor — PMO required' };
  }

  try {
    const sleepManager = require('./sleepManager');
    return sleepManager.sleep(args.target_uid, {
      wakeAfterMinutes: args.wake_after_minutes || 5,
    });
  } catch {
    return { ok: false, error: 'sleepManager not available — will be implemented in Phase 6' };
  }
}

async function _dagWakeAgent(args, ctx) {
  const store = require('./store');
  const caller = store.getAgent(ctx.uid);
  if (!caller || (caller.role !== 'supervisor' && caller.role !== 'pmo')) {
    return { error: 'wake requires PM or PMO role' };
  }

  try {
    const sleepManager = require('./sleepManager');
    return sleepManager.wake(args.target_uid);
  } catch {
    // Fallback: delegate to handlersAdmin._wakeAgent.
    const admin = require('./handlersAdmin');
    return admin._wakeAgent({ target_uid: args.target_uid }, ctx);
  }
}

async function _pmoPoll(args, ctx) {
  const store = require('./store');
  const caller = store.getAgent(ctx.uid);
  if (!caller || caller.role !== 'pmo') {
    return { error: 'pmo_poll is restricted to PMO role' };
  }

  try {
    const pmoEngine = require('./pmoEngine');
    return pmoEngine.poll(args.workspace || ctx.workspace || 'boos');
  } catch {
    return { ok: false, error: 'pmoEngine not available — will be implemented in Phase 4' };
  }
}

module.exports = {
  _dagCreate, _dagAddTask, _dagActivate, _dagStatus, _dagCancel,
  _dagSubmitTask, _dagApproveTask, _dagRejectTask, _dagMyTasks,
  _dagReassignTask, _dagList, _dagSleepAgent, _dagWakeAgent, _pmoPoll,
  _requirePMorPMO,
};

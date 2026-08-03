// DAG task system MCP handlers — Sprint 31.
//
// Handles all dag_* MCP tools. Polling is handled by autoSupervisor.js
// (code layer) — no AI agent performs polling. Imported by handlers.js
// dispatch() for DAG-related switch cases.
//
// Permission model (hardcoded):
//   dag_create / dag_add_task / dag_activate / dag_cancel / dag_reassign_task → PM/PMO only
//   dag_submit_task → executor only
//   dag_approve_task / dag_reject_task → reviewer only
//   dag_my_tasks / dag_status / dag_list → any registered agent
//   dag_sleep_agent / dag_wake_agent → PM/PMO only

'use strict';

const auth = require('./auth');

function _requirePMorPMO(ctx) {
  const err = auth.requirePMorPMO(ctx);
  if (err) throw new Error(err.error);
}

async function _dagCreate(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;
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
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;
  const dagStore = require('./dagStore');
  const task = await dagStore.addTask(args.dag_id, args);
  return { ok: true, task };
}

async function _dagActivate(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;
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
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;
  const dagStore = require('./dagStore');
  await dagStore.cancelDag(args.dag_id, args.reason);
  return { ok: true, dag_id: args.dag_id, status: 'cancelled' };
}

async function _dagSubmitTask(args, ctx) {
  const taskSystem = require('./taskSystem');
  const result = await taskSystem.submitTask(args.task_id, ctx.uid, {
    content: args.content,
    attachments: args.attachments,
  });
  if (result.ok) result.executor = ctx.uid;
  return result;
}

async function _dagApproveTask(args, ctx) {
  const taskSystem = require('./taskSystem');
  const result = await taskSystem.approveTask(args.task_id, ctx.uid, {
    comment: args.comment,
  });
  // Post-approval cascade: notify newly-ready executors via dagEngine.
  if (result.ok) {
    result.reviewer = ctx.uid;
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
  if (result.ok) {
    result.reviewer = ctx.uid;
    if (result.escalated) {
      try {
        const dagEngine = require('./dagEngine');
        await dagEngine.onTaskEscalated(args.task_id);
      } catch {}
    }
  }
  return result;
}

async function _dagMyTasks(args, ctx) {
  const dagStore = require('./dagStore');
  const tasks = dagStore.getMyDagTasks(ctx.uid);
  return { ok: true, ...tasks };
}

async function _dagReassignTask(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;
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
  // Sprint 35: any registered agent can wake another in the same workspace.
  // Peer-to-peer wake is a core collaboration primitive — no PM/PMO required.
  const target = store.getAgent(args.target_uid);
  if (!target) return { error: `agent ${args.target_uid} not found` };
  if (caller && target.workspace !== caller.workspace) {
    return { error: 'cannot wake agents in other workspaces' };
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

async function _dagDecompose(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagDecomposer = require('./dagDecomposer');
  return dagDecomposer.decompose({
    title: args.title,
    description: args.description,
    workspace: args.workspace || ctx.workspace || 'boos',
    createdBy: ctx.uid,
    tasks: args.tasks,
    autoActivate: args.auto_activate !== false, // default true
  });
}

async function _dagSuggestAssignments(args, ctx) {
  // Any registered agent can call this to get suggestions before decompose.
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const dagDecomposer = require('./dagDecomposer');
  return dagDecomposer.suggestAssignments(
    args.workspace || ctx.workspace || 'boos',
    args.tasks
  );
}

// ── Sprint 37: Goal handlers ──────────────────────────────────────────

async function _goalCreate(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const goalStore = require('./goalStore');
  const result = await goalStore.createGoal({
    title: args.title,
    description: args.description,
    workspace: args.workspace || ctx.workspace || 'boos',
    project: args.project || null,
    creatorUid: ctx.uid,
  });

  if (result.ok) {
    // Notify PM: new goal submitted.
    try {
      const feedbackManager = require('./feedbackManager');
      await feedbackManager.sendFeedback({
        goalId: result.goal.goal_id,
        content: `New Goal submitted: "${args.title}"\n${args.description || ''}`,
        fromUid: ctx.uid,
        fromName: ctx.name || 'Agent',
        type: 'overall',
      });
    } catch {}
  }

  return result;
}

async function _goalList(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const goalStore = require('./goalStore');
  const goals = await goalStore.listGoals(
    args.workspace || ctx.workspace || 'boos',
    args.project || null,
    args.status || null
  );
  return { ok: true, goals, count: goals.length };
}

async function _goalStatus(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const goalStore = require('./goalStore');
  const goal = goalStore.getGoal(args.goal_id);
  if (!goal) return { error: 'goal not found: ' + args.goal_id };

  // Enrich with DAG statuses.
  const dagStore = require('./dagStore');
  const dags = goal.dag_ids.map((dagId) => {
    const dag = dagStore.getDag(dagId);
    const summary = dag ? dagStore.getDagSummary(dagId) : null;
    return { dag_id: dagId, dag, summary };
  });

  return { ok: true, goal, dags };
}

async function _goalUpdate(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const goalStore = require('./goalStore');
  const updates = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.description !== undefined) updates.description = args.description;
  if (args.status !== undefined) updates.status = args.status;
  if (args.assigned_pm_uid !== undefined) updates.assigned_pm_uid = args.assigned_pm_uid;
  if (args.assigned_pmo_uid !== undefined) updates.assigned_pmo_uid = args.assigned_pmo_uid;

  try {
    return await goalStore.updateGoal(args.goal_id, updates);
  } catch (e) {
    return { error: e.message };
  }
}

async function _goalArchive(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const goalStore = require('./goalStore');
  try {
    return await goalStore.archiveGoal(args.goal_id);
  } catch (e) {
    return { error: e.message };
  }
}

async function _goalStart(args, ctx) {
  const rootErr = auth.requireRoot(ctx);
  if (rootErr) return rootErr;

  const goalStore = require('./goalStore');
  try {
    return await goalStore.startGoal(args.goal_id);
  } catch (e) {
    return { error: e.message };
  }
}

async function _goalPause(args, ctx) {
  const rootErr = auth.requireRoot(ctx);
  if (rootErr) return rootErr;

  const goalStore = require('./goalStore');
  try {
    return await goalStore.pauseGoal(args.goal_id);
  } catch (e) {
    return { error: e.message };
  }
}

// ── Sprint 37: Review question handlers ───────────────────────────────

async function _dagAddQuestions(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  const task = dagStore.getTask(args.task_id);
  if (!task) return { error: 'task not found: ' + args.task_id };

  const newQuestions = (args.questions || []).map((q) => ({
    question_id: 'q_' + require('node:crypto').randomUUID().slice(0, 8),
    question: q.question,
    options: q.options || [],
    user_choice: null,
    impact: q.impact || '',
    answered_at: null,
    skipped: false,
  }));

  // Merge with existing questions.
  const existing = task.review_questions || [];
  const merged = [...existing, ...newQuestions];

  const { withFileLock } = require('./storeCore');
  const { atomicWriteJson } = require('../atomicJson');
  const store = require('./store');

  await withFileLock(store.DB_PATH, async () => {
    const db = await store._load();
    if (db.dag_tasks && db.dag_tasks[args.task_id]) {
      db.dag_tasks[args.task_id].review_questions = merged;
      await atomicWriteJson(store.DB_PATH, db);
    }
  });

  return { ok: true, task_id: args.task_id, questions_added: newQuestions.length, total_questions: merged.length };
}

async function _dagAnswerQuestion(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const feedbackManager = require('./feedbackManager');
  return feedbackManager.sendDecisionAnswer({
    taskId: args.task_id,
    questionId: args.question_id,
    choice: {
      choice: args.choice || null,
      skipped: args.skipped || false,
      custom_text: args.custom_text || null,
    },
    fromUid: ctx.uid,
  });
}

// ── Sprint 37: Proposal handlers ──────────────────────────────────────

async function _dagProposeTask(args, ctx) {
  const regErr = auth.requireRegistered(ctx);
  if (regErr) return regErr;

  const dagStore = require('./dagStore');

  // Validate DAG exists.
  const dag = dagStore.getDag(args.dag_id);
  if (!dag) return { error: 'DAG not found: ' + args.dag_id };

  const { withFileLock } = require('./storeCore');
  const { atomicWriteJson } = require('../atomicJson');
  const store = require('./store');

  const taskId = dagStore.genTaskId();

  try {
    await withFileLock(store.DB_PATH, async () => {
      const db = await store._load();
      if (!db.dag_tasks) db.dag_tasks = {};

      const task = {
        task_id: taskId,
        dag_id: args.dag_id,
        title: args.title.slice(0, 128),
        description: (args.description || '').slice(0, 4096),
        executor_uid: null,  // Assigned on approval.
        reviewer_uid: null,  // Assigned on approval.
        dependencies: [],
        acceptance_criteria: (args.acceptance_criteria || '').slice(0, 2048),
        status: 'proposed',
        priority: args.priority || 'normal',
        submit_content: null,
        submit_attachments: null,
        review_comment: null,
        review_history: [],
        retry_count: 0,
        max_retries: 3,
        created_at: new Date().toISOString(),
        activated_at: null,
        submitted_at: null,
        reviewed_at: null,
        completed_at: null,
        publisher_uid: ctx.uid,
        proposal_reason: args.description || null,
        proposed_at: new Date().toISOString(),
        review_questions: [],
        user_notes: [],
        force_modified_at: null,
        force_modified_by: null,
        re_notified_to_executor: false,
      };

      db.dag_tasks[taskId] = task;
      await atomicWriteJson(store.DB_PATH, db);
    });

    // Block the associated task if specified.
    if (args.blocking_task_id) {
      try {
        const queue = require('./queue');
        await queue.blockTask(args.blocking_task_id,
          `Proposed task "${args.title}" (${taskId}) is pending PM+PMO review.`
        );
      } catch {}
    }

    // Notify PM about the proposal.
    try {
      const feedbackManager = require('./feedbackManager');
      const goalId = dag.goal_id;
      if (goalId) {
        await feedbackManager.sendFeedback({
          goalId,
          taskId,
          content: `New proposal: "${args.title}" by ${ctx.name || ctx.uid.slice(-8)}\n${args.description || ''}`,
          fromUid: ctx.uid,
          fromName: ctx.name || 'Agent',
          type: 'proposal',
        });
      }
    } catch {}

    return { ok: true, task_id: taskId, status: 'proposed', publisher: ctx.uid, blocking_task_id: args.blocking_task_id || null };
  } catch (e) {
    return { error: e.message };
  }
}

async function _dagApproveProposal(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  try {
    const result = await dagStore.approveProposal(args.task_id, {
      executorUid: args.executor_uid,
      reviewerUid: args.reviewer_uid,
      dependencies: args.dependencies || [],
      acceptanceCriteria: args.acceptance_criteria || '',
    });
    if (result && result.ok) result.approver = ctx.uid;
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function _dagRejectProposal(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  try {
    const result = await dagStore.rejectProposal(args.task_id, args.reason);
    if (result && result.ok) result.rejector = ctx.uid;
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

// ── Sprint 37: Runtime adjustment handlers ────────────────────────────

async function _dagRearrange(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  const task = dagStore.getTask(args.task_id);
  if (!task) return { error: 'task not found: ' + args.task_id };

  const { withFileLock } = require('./storeCore');
  const { atomicWriteJson } = require('../atomicJson');
  const store = require('./store');

  try {
    await withFileLock(store.DB_PATH, async () => {
      const db = await store._load();
      const t = db.dag_tasks[args.task_id];
      if (!t) throw new Error('task not found');

      let deps = [...(t.dependencies || [])];

      // Add dependencies.
      if (args.add_dependencies && args.add_dependencies.length > 0) {
        for (const depId of args.add_dependencies) {
          if (!deps.includes(depId)) deps.push(depId);
        }
      }

      // Remove dependencies.
      if (args.remove_dependencies && args.remove_dependencies.length > 0) {
        deps = deps.filter((d) => !args.remove_dependencies.includes(d));
      }

      // Validate no cycles in the DAG.
      const dagTasks = Object.values(db.dag_tasks).filter((x) => x.dag_id === t.dag_id);
      const taskMap = {};
      for (const dt of dagTasks) {
        taskMap[dt.task_id] = dt.dependencies || [];
      }
      taskMap[args.task_id] = deps;

      // Simple cycle detection via DFS.
      const visited = new Set();
      const recStack = new Set();
      function hasCycle(nodeId) {
        if (recStack.has(nodeId)) return true;
        if (visited.has(nodeId)) return false;
        visited.add(nodeId);
        recStack.add(nodeId);
        for (const dep of (taskMap[nodeId] || [])) {
          if (hasCycle(dep)) return true;
        }
        recStack.delete(nodeId);
        return false;
      }
      if (hasCycle(args.task_id)) {
        throw new Error('rearrangement would create a circular dependency');
      }

      t.dependencies = deps;
      await atomicWriteJson(store.DB_PATH, db);
    });

    const updated = dagStore.getTask(args.task_id);
    return { ok: true, task_id: args.task_id, dependencies: updated.dependencies };
  } catch (e) {
    return { error: e.message };
  }
}

async function _dagForceModify(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  try {
    const result = await dagStore.forceModifyTask(args.task_id, {
      title: args.title,
      description: args.description,
      executorUid: args.executor_uid,
      reviewerUid: args.reviewer_uid,
      acceptanceCriteria: args.acceptance_criteria,
      priority: args.priority,
      reason: args.reason,
    }, ctx.uid);

    // Re-notify executor via agent-bus task queue + wake.
    if (result.ok && result.task) {
      try {
        const queue = require('./queue');
        const task = result.task;
        if (task.executor_uid) {
          const notifyResult = await queue.sendTask({
            sender: { uid: ctx.uid, name: ctx.name || 'PM', intro: 'Force-modify notification.' },
            receiver_uid: task.executor_uid,
            content: `[FORCE MODIFIED] Task "${task.title}" (${task.task_id}) was modified by PM.\n` +
              `Reason: ${args.reason}\n` +
              `Please review the updated task and re-submit your work.`,
            priority: 'high',
            metadata: { type: 'dag_force_modify', task_id: args.task_id, dag_id: task.dag_id },
          });

          if (notifyResult.ok) {
            // Mark re-notified.
            const { withFileLock } = require('./storeCore');
            const { atomicWriteJson } = require('../atomicJson');
            const store = require('./store');
            await withFileLock(store.DB_PATH, async () => {
              const db = await store._load();
              if (db.dag_tasks && db.dag_tasks[args.task_id]) {
                db.dag_tasks[args.task_id].re_notified_to_executor = true;
                await atomicWriteJson(store.DB_PATH, db);
              }
            });

            // Wake the executor.
            try {
              const notifications = require('./notifications');
              await notifications.wakeAgent(task.executor_uid, {
                urgency: 'urgent',
                sender_name: 'PM',
                message: `Task "${task.title}" was force-modified. Check your inbox.`,
              });
            } catch {}
          }
        }
      } catch {}
    }

    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function _dagPartialRollback(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const dagStore = require('./dagStore');
  try {
    return await dagStore.deleteTaskNode(args.task_id);
  } catch (e) {
    return { error: e.message };
  }
}

// ── Sprint 37: Conflict escalation ────────────────────────────────────

async function _dagEscalateConflict(args, ctx) {
  const pmErr = auth.requirePMorPMO(ctx);
  if (pmErr) return pmErr;

  const feedbackManager = require('./feedbackManager');
  const dagStore = require('./dagStore');

  const task = dagStore.getTask(args.task_id);
  const dag = task ? dagStore.getDag(task.dag_id) : null;
  const goalId = dag ? dag.goal_id : null;

  const message = `⚖️ PM+PMO CONFLICT on task "${task ? task.title : args.task_id}"\n` +
    `Summary: ${args.summary}\n\n` +
    `PM opinion: ${args.pm_opinion}\n\n` +
    `PMO opinion: ${args.pmo_opinion}\n\n` +
    `Please decide in the Decision Area.`;

  return feedbackManager.notifyUser({
    goalId,
    message,
    type: 'conflict',
    metadata: {
      task_id: args.task_id,
      pm_opinion: args.pm_opinion,
      pmo_opinion: args.pmo_opinion,
      escalated_by: ctx.uid,
    },
  });
}

module.exports = {
  _dagCreate, _dagAddTask, _dagActivate, _dagStatus, _dagCancel,
  _dagSubmitTask, _dagApproveTask, _dagRejectTask, _dagMyTasks,
  _dagReassignTask, _dagList, _dagSleepAgent, _dagWakeAgent,
  _dagDecompose, _dagSuggestAssignments,
  // Sprint 37: Goal system
  _goalCreate, _goalList, _goalStatus, _goalUpdate, _goalArchive,
  _goalStart, _goalPause,
  // Sprint 37: Review questions
  _dagAddQuestions, _dagAnswerQuestion,
  // Sprint 37: Proposal system
  _dagProposeTask, _dagApproveProposal, _dagRejectProposal,
  // Sprint 37: Runtime adjustment
  _dagRearrange, _dagForceModify, _dagPartialRollback,
  // Sprint 37: Conflict escalation
  _dagEscalateConflict,
  _requirePMorPMO,
};

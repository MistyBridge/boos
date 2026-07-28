// DAG task orchestration engine — Sprint 31 Phase 3.
//
// Coordinates between dagStore (persistence) and taskSystem (state machine)
// to provide: post-approval cascade, DAG completion detection, SSE progress
// notifications, and bulk task activation tracking.
//
// This is the "glue" layer — it doesn't duplicate dagStore/taskSystem logic
// but adds the event-driven orchestration they lack individually.

'use strict';

const dagStore = require('./dagStore');
const taskSystem = require('./taskSystem');

// ── SSE notification reference (set by notifications.js) ──────────────
let _notify = null;
function setNotify(fn) { _notify = fn; }

// ── Approval cascade ───────────────────────────────────────────────────
// Called after a task is approved. Unlocks downstream tasks whose
// dependencies are now fully satisfied, and notifies affected agents.

async function afterTaskApproved(taskId) {
  const task = dagStore.getTask(taskId);
  if (!task) return { unlocked: [] };

  // _unlockDependents is called internally by dagStore.updateTaskStatus
  // when status transitions to 'approved'. This function adds SSE
  // notifications and returns structured cascade info.

  const dag = dagStore.getDag(task.dag_id);
  const summary = dagStore.getDagSummary(task.dag_id);

  // Find newly-ready tasks (those that just became active because all
  // their deps are now approved).
  const allTasks = dag.tasks || [];
  const newlyReady = allTasks.filter((t) => {
    if (t.status !== 'active') return false;
    if (!t.dependencies || t.dependencies.length === 0) return false;
    // Check if this task's last unsatisfied dep was the one just approved.
    const deps = t.dependencies.map((depId) => dagStore.getTask(depId)).filter(Boolean);
    const unapproved = deps.filter((d) => d.status !== 'approved');
    // If taskId is in this task's dependencies AND there are no unapproved deps,
    // this task was just unlocked by the current approval.
    return t.dependencies.includes(taskId) && unapproved.length === 0;
  });

  // SSE notify: DAG progress update.
  if (_notify) {
    try {
      _notify('dag_progress', {
        dag_id: task.dag_id,
        event: 'task_approved',
        task_id: taskId,
        title: task.title,
        executor_uid: task.executor_uid,
        reviewer_uid: task.reviewer_uid,
        summary,
        newly_ready: newlyReady.map((t) => t.task_id),
        completed: summary.approved === summary.total,
      });
    } catch {}
  }

  // Notify newly-ready executors.
  const notifications = [];
  for (const t of newlyReady) {
    notifications.push({
      task_id: t.task_id,
      executor_uid: t.executor_uid,
      title: t.title,
      unlocked_by: taskId,
    });
  }

  return {
    dag_id: task.dag_id,
    task_id: taskId,
    summary,
    newly_ready_tasks: newlyReady.map((t) => t.task_id),
    dag_completed: summary.approved === summary.total,
    notifications,
  };
}

// ── DAG completion ─────────────────────────────────────────────────────

async function afterDagCompleted(dagId) {
  const dag = dagStore.getDag(dagId);
  if (!dag || dag.status !== 'completed') return null;

  const summary = dagStore.getDagSummary(dagId);

  if (_notify) {
    try {
      _notify('dag_completed', {
        dag_id: dagId,
        title: dag.title,
        workspace: dag.workspace,
        completed_at: dag.completed_at,
        summary,
      });
    } catch {}
  }

  return {
    dag_id: dagId,
    title: dag.title,
    workspace: dag.workspace,
    completed_at: dag.completed_at,
    summary,
  };
}

// ── Progress query ─────────────────────────────────────────────────────
// Structured progress report for frontend / PM dashboard.

function getDagProgress(dagId) {
  const dag = dagStore.getDag(dagId);
  if (!dag) return null;

  const summary = dagStore.getDagSummary(dagId);
  const tasks = dag.tasks || [];

  // Per-task progress with blocking info.
  const taskProgress = tasks.map((t) => {
    const blockers = (t.dependencies || [])
      .map((depId) => dagStore.getTask(depId))
      .filter((d) => d && d.status !== 'approved')
      .map((d) => ({ task_id: d.task_id, title: d.title, status: d.status }));
    return {
      task_id: t.task_id,
      title: t.title,
      status: t.status,
      executor_uid: t.executor_uid,
      reviewer_uid: t.reviewer_uid,
      retry_count: t.retry_count || 0,
      blockers: blockers.length > 0 ? blockers : null,
      submitted_at: t.submitted_at || null,
      reviewed_at: t.reviewed_at || null,
    };
  });

  return {
    dag_id: dagId,
    title: dag.title,
    status: dag.status,
    created_at: dag.created_at,
    completed_at: dag.completed_at || null,
    summary,
    tasks: taskProgress,
    // Percentage complete (approved / total).
    pct_complete: summary.total > 0
      ? Math.round((summary.approved / summary.total) * 100)
      : 0,
  };
}

// ── Bulk activation (Phase 3) ──────────────────────────────────────────
// Called when a DAG is activated. Returns structured activation report
// with ready tasks and blocked tasks.

async function activateWithReport(dagId) {
  const result = await dagStore.activateDag(dagId);
  const dag = dagStore.getDag(dagId);
  const allTasks = dag.tasks || [];

  const ready = allTasks.filter((t) => t.status === 'active');
  const blocked = allTasks.filter((t) => t.status === 'pending');

  if (_notify) {
    try {
      _notify('dag_activated', {
        dag_id: dagId,
        title: dag.title,
        ready_count: ready.length,
        blocked_count: blocked.length,
        total: allTasks.length,
      });
    } catch {}
  }

  return {
    dag_id: dagId,
    status: 'active',
    ready_tasks: ready.map((t) => ({
      task_id: t.task_id, title: t.title,
      executor_uid: t.executor_uid, reviewer_uid: t.reviewer_uid,
    })),
    blocked_tasks: blocked.map((t) => ({
      task_id: t.task_id, title: t.title,
      missing_deps: (t.dependencies || []).filter((depId) => {
        const dep = dagStore.getTask(depId);
        return dep && dep.status !== 'approved';
      }),
    })),
    ready_count: ready.length,
    blocked_count: blocked.length,
  };
}

// ── Escalation handler ─────────────────────────────────────────────────
// Called when a task is escalated (3 retries exhausted). Notifies PM.

async function onTaskEscalated(taskId) {
  const task = dagStore.getTask(taskId);
  if (!task || task.status !== 'escalated') return null;

  if (_notify) {
    try {
      _notify('task_escalated', {
        task_id: taskId,
        title: task.title,
        dag_id: task.dag_id,
        executor_uid: task.executor_uid,
        reviewer_uid: task.reviewer_uid,
        retry_count: task.retry_count || 0,
        review_comment: task.review_comment || '',
      });
    } catch {}
  }

  return {
    task_id: taskId,
    dag_id: task.dag_id,
    title: task.title,
    escalated: true,
    hint: `Task ${taskId} escalated after ${task.retry_count} rejections. PM intervention required.`,
  };
}

module.exports = {
  setNotify,
  afterTaskApproved,
  afterDagCompleted,
  getDagProgress,
  activateWithReport,
  onTaskEscalated,
};

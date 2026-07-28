// DAG task state machine — submit/approve/reject workflow with hardcoded
// permission enforcement.
//
// Sprint 31: This is the core execution/review separation engine. Every
// state transition checks the caller's identity against the task's
// executor_uid / reviewer_uid. The permissions are NOT configurable —
// they are hardcoded in code:
//
//   submit  → only executor_uid
//   approve → only reviewer_uid
//   reject  → only reviewer_uid (with mandatory comment)
//
// Max retries: when retry_count reaches max_retries (default 3), the task
// is auto-escalated to "escalated" status and the PM is notified.

'use strict';

const dagStore = require('./dagStore');
const store = require('./store');

// ── permission checks (hardcoded) ────────────────────────────────────────

function _requireExecutor(task, callerUid) {
  if (task.executor_uid !== callerUid) {
    throw new Error(
      `Permission denied: only the executor (${task.executor_uid}) can submit this task. ` +
      `Caller is ${callerUid}.`
    );
  }
}

function _requireReviewer(task, callerUid) {
  if (task.reviewer_uid !== callerUid) {
    throw new Error(
      `Permission denied: only the reviewer (${task.reviewer_uid}) can approve/reject this task. ` +
      `Caller is ${callerUid}.`
    );
  }
}

function _requirePMorPMO(callerUid) {
  const agent = store.getAgent(callerUid);
  if (!agent || (agent.role !== 'supervisor' && agent.role !== 'pmo')) {
    throw new Error(
      `Permission denied: only PM (supervisor) or PMO can perform this operation. ` +
      `Caller role is ${agent ? agent.role : 'unknown'}.`
    );
  }
}

// ── state machine transitions ────────────────────────────────────────────

/**
 * Submit a task for review. Only the executor can submit.
 * Status: active → submitted
 */
async function submitTask(taskId, callerUid, { content, attachments } = {}) {
  const task = dagStore.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  _requireExecutor(task, callerUid);

  if (task.status !== 'active') {
    throw new Error(
      `task ${taskId} is not in 'active' status (current: ${task.status}). ` +
      `Only active tasks can be submitted.`
    );
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('submit requires non-empty content (description of what was done)');
  }

  const updated = await dagStore.updateTaskStatus(taskId, 'submitted', {
    submit_content: content.trim(),
    submit_attachments: attachments || null,
  });

  return { ok: true, task_id: taskId, status: 'submitted', task: updated };
}

/**
 * Approve a submitted task. Only the reviewer can approve.
 * Status: submitted → approved
 *
 * On approval, downstream tasks with satisfied dependencies are auto-unlocked.
 */
async function approveTask(taskId, callerUid, { comment } = {}) {
  const task = dagStore.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  _requireReviewer(task, callerUid);

  if (task.status !== 'submitted') {
    throw new Error(
      `task ${taskId} is not in 'submitted' status (current: ${task.status}). ` +
      `Only submitted tasks can be approved.`
    );
  }

  const updated = await dagStore.updateTaskStatus(taskId, 'approved', {
    review_comment: comment || 'Approved.',
    reviewer_uid: callerUid,
  });

  // Check if this unlock makes downstream tasks ready.
  const newlyReady = await dagStore._unlockDependents
    ? [] // handled inside updateTaskStatus → _unlockDependents
    : [];

  return {
    ok: true,
    task_id: taskId,
    status: 'approved',
    task: updated,
    newly_ready_tasks: newlyReady.length > 0 ? newlyReady : undefined,
  };
}

/**
 * Reject a submitted task with mandatory review comment.
 * Only the reviewer can reject.
 * Status: submitted → active (retry_count incremented)
 *
 * If retry_count reaches max_retries, the task is auto-escalated instead.
 */
async function rejectTask(taskId, callerUid, { comment } = {}) {
  const task = dagStore.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  _requireReviewer(task, callerUid);

  if (task.status !== 'submitted') {
    throw new Error(
      `task ${taskId} is not in 'submitted' status (current: ${task.status}). ` +
      `Only submitted tasks can be rejected.`
    );
  }

  if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
    throw new Error(
      'reject requires a non-empty comment explaining what needs to be fixed. ' +
      'The executor needs actionable feedback to improve their submission.'
    );
  }

  const newRetryCount = (task.retry_count || 0) + 1;

  // Auto-escalate if max retries exceeded.
  if (newRetryCount >= (task.max_retries || 3)) {
    const escalated = await dagStore.escalateTask(taskId,
      `Rejected ${newRetryCount} times (max: ${task.max_retries || 3}). ` +
      `Last review comment: ${comment.trim()}`
    );
    return {
      ok: true,
      task_id: taskId,
      status: 'escalated',
      retry_count: newRetryCount,
      escalated: true,
      hint: `Task ${taskId} has been escalated after ${newRetryCount} rejections. PM intervention required.`,
      task: escalated,
    };
  }

  // Normal reject: send back to active for retry.
  const updated = await dagStore.updateTaskStatus(taskId, 'active', {
    review_comment: comment.trim(),
    reviewer_uid: callerUid,
    review_action: 'rejected',  // record rejection in history even though status → active
    retry_count: newRetryCount,
    submit_content: null,       // clear previous submission
    submit_attachments: null,   // clear previous attachments
  });

  return {
    ok: true,
    task_id: taskId,
    status: 'active',
    retry_count: newRetryCount,
    remaining_retries: (task.max_retries || 3) - newRetryCount,
    task: updated,
  };
}

// ── PM/PMO operations ────────────────────────────────────────────────────

/**
 * Cancel a DAG task. PM/PMO only.
 */
async function cancelDagTask(taskId, callerUid, reason) {
  _requirePMorPMO(callerUid);
  const updated = await dagStore.cancelTask(taskId, reason || 'Cancelled by PM/PMO');
  return { ok: true, task_id: taskId, status: 'cancelled', task: updated };
}

/**
 * Reassign executor or reviewer. PM/PMO only.
 * Re-validates executor !== reviewer after reassignment.
 */
async function reassignDagTask(taskId, callerUid, { newExecutorUid, newReviewerUid } = {}) {
  _requirePMorPMO(callerUid);

  if (!newExecutorUid && !newReviewerUid) {
    throw new Error('reassign requires at least new_executor_uid or new_reviewer_uid');
  }

  await dagStore.reassignTask(taskId, { newExecutorUid, newReviewerUid });
  const updated = dagStore.getTask(taskId);

  return {
    ok: true,
    task_id: taskId,
    executor_uid: updated.executor_uid,
    reviewer_uid: updated.reviewer_uid,
    status: updated.status,
    task: updated,
  };
}

module.exports = {
  submitTask,
  approveTask,
  rejectTask,
  cancelDagTask,
  reassignDagTask,
  _requireExecutor,
  _requireReviewer,
  _requirePMorPMO,
};

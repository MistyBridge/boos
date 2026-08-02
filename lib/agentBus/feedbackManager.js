// Goal feedback manager — Sprint 37.
//
// Routes user feedback through agent-bus inbox, checks PM idle state
// before waking, and sends ROOT inbox notifications for user alerts.
//
// Key behaviors:
//   - Feedback goes to PM inbox (FIFO), but PM is only woken when idle.
//   - Messages accumulate when PM is busy — no loss, FIFO consumption.
//   - User notifications (BOOS popup + ROOT inbox) for DAG conflicts.

'use strict';

const queue = require('./queue');
const goalStore = require('./goalStore');
const collaborationLoop = require('./collaborationLoop');
const store = require('./store');

// ── PM idle check ────────────────────────────────────────────────────────

/**
 * Check if the PM is currently idle (no in_progress tasks).
 * Used to decide whether to wake the PM on new feedback.
 */
async function isPmIdle(workspace) {
  const pmUid = goalStore.resolveProjectPM(workspace);
  if (!pmUid) return false;
  try {
    const state = await collaborationLoop.getAgentState(pmUid);
    return state && state.state === 'idle';
  } catch {
    return false;
  }
}

/**
 * Get the PM UID for a workspace.
 */
function getPmUid(workspace) {
  return goalStore.resolveProjectPM(workspace);
}

// ── feedback routing ─────────────────────────────────────────────────────

/**
 * Route user feedback to the PM inbox.
 *
 * Feedback is always added to the Goal's feedback_thread for persistence.
 * It's also sent to the PM's agent-bus inbox. The PM is only woken if idle
 * — when busy, feedback accumulates in the FIFO queue naturally.
 *
 * @param {object} opts
 * @param {string} opts.goalId - Goal ID
 * @param {string} [opts.taskId] - Target task ID (for node-level feedback)
 * @param {string} opts.content - Feedback content
 * @param {string} opts.fromUid - Sender UID
 * @param {string} opts.fromName - Sender display name
 * @param {string} [opts.type] - 'overall' | 'node' | 'proposal' | 'decision'
 */
async function sendFeedback({ goalId, taskId, content, fromUid, fromName, type }) {
  const goal = goalStore.getGoal(goalId);
  if (!goal) return { ok: false, error: 'goal not found: ' + goalId };

  const pmUid = getPmUid(goal.workspace);
  if (!pmUid) return { ok: false, error: 'no PM found for workspace "' + goal.workspace + '"' };

  // 1. Persist to goal's feedback_thread.
  await goalStore.addFeedback(goalId, {
    fromUid, fromName, content,
    type: type || (taskId ? 'node' : 'overall'),
    targetTaskId: taskId || null,
  });

  // 2. Send to PM's agent-bus inbox.
  const taskType = taskId ? `feedback:node:${taskId}` : 'feedback:overall';
  const sendResult = await queue.sendTask({
    sender: { uid: fromUid, name: fromName, intro: 'Goal feedback from user.' },
    receiver_uid: pmUid,
    content: `[Goal: ${goal.title}] [${taskType}]\n${content}`,
    priority: 'normal',
    metadata: {
      type: 'goal_feedback',
      goal_id: goalId,
      target_task_id: taskId || null,
      feedback_type: type || 'overall',
    },
  });

  // 3. Wake PM only if idle.
  let woke = false;
  const pmIsIdle = await isPmIdle(goal.workspace);
  if (pmIsIdle) {
    try {
      const notifications = require('./notifications');
      await notifications.wakeAgent(pmUid, {
        urgency: 'normal',
        sender_name: fromName,
        message: `New feedback on Goal "${goal.title}"`,
      });
      woke = true;
    } catch {}
  }

  return {
    ok: true,
    goal_id: goalId,
    feedback_persisted: true,
    pm_notified: sendResult.ok,
    pm_woke: woke,
    pm_was_idle: pmIsIdle,
  };
}

/**
 * Send a user-facing notification (BOOS popup + ROOT inbox).
 * Used for: proposal conflicts escalated to ROOT, DAG completion notices.
 *
 * @param {object} opts
 * @param {string} opts.goalId
 * @param {string} opts.message - Human-readable message
 * @param {string} [opts.type] - 'conflict' | 'completion' | 'info'
 * @param {object} [opts.metadata] - Additional structured data
 */
async function notifyUser({ goalId, message, type, metadata }) {
  // Find ROOT agent in the workspace.
  const goal = goalId ? goalStore.getGoal(goalId) : null;
  const workspace = goal ? goal.workspace : 'boos';

  // ROOT UID: look for agent with role 'root' in workspace '*'.
  let rootUid = null;
  try {
    const db = store._syncLoad ? store._syncLoad() : null;
    if (db && db.agents) {
      for (const [uid, a] of Object.entries(db.agents)) {
        if (a.role === 'root') { rootUid = uid; break; }
      }
    }
  } catch {}

  if (!rootUid) {
    // No ROOT agent registered — still persist to goal's feedback_thread.
    if (goalId) {
      await goalStore.addFeedback(goalId, {
        fromUid: 'system',
        fromName: 'BOOS System',
        content: message,
        type: type || 'info',
        targetTaskId: null,
      });
    }
    return { ok: true, root_notified: false, reason: 'no ROOT agent registered' };
  }

  // Send to ROOT's agent-bus inbox.
  const sendResult = await queue.sendTask({
    sender: { uid: 'agent_root', name: 'BOOS System', intro: 'Goal system notification.' },
    receiver_uid: rootUid,
    content: message,
    priority: type === 'conflict' ? 'high' : 'normal',
    metadata: {
      type: 'goal_notification',
      goal_id: goalId || null,
      notification_type: type || 'info',
      ...(metadata || {}),
    },
  });

  // Wake ROOT.
  if (sendResult.ok) {
    try {
      const notifications = require('./notifications');
      await notifications.wakeAgent(rootUid, {
        urgency: type === 'conflict' ? 'urgent' : 'normal',
        sender_name: 'BOOS System',
        message,
      });
    } catch {}
  }

  return { ok: true, root_notified: sendResult.ok };
}

/**
 * Send an answer to a DAG review question.
 * Answers are persisted to the task's review_questions and forwarded
 * to the PM for processing.
 *
 * @param {string} taskId - DAG task ID
 * @param {string} questionId - Question ID within the task
 * @param {object} choice - { choice: string | null, skipped: boolean, custom_text?: string }
 * @param {string} fromUid - User who answered
 */
async function sendDecisionAnswer({ taskId, questionId, choice, fromUid }) {
  const dagStore = require('./dagStore');
  const task = dagStore.getTask(taskId);
  if (!task) return { ok: false, error: 'task not found: ' + taskId };

  // Find and update the question.
  const questions = task.review_questions || [];
  const q = questions.find((q) => q.question_id === questionId);
  if (!q) return { ok: false, error: 'question not found: ' + questionId };

  q.user_choice = choice.choice || null;
  q.skipped = choice.skipped || false;
  q.answered_at = new Date().toISOString();

  if (choice.custom_text) {
    q.user_choice = 'custom:' + choice.custom_text;
  }

  // Persist the updated questions.
  const { withFileLock } = require('./storeCore');
  const { atomicWriteJson } = require('../atomicJson');
  const storeMod = require('./store');

  await withFileLock(storeMod.DB_PATH, async () => {
    const db = await storeMod._load();
    if (db.dag_tasks && db.dag_tasks[taskId]) {
      db.dag_tasks[taskId].review_questions = questions;
      await atomicWriteJson(storeMod.DB_PATH, db);
    }
  });

  // Notify PM about the answer.
  const dag = dagStore.getDag(task.dag_id);
  if (dag) {
    const goalId = dag.goal_id;
    if (goalId) {
      await sendFeedback({
        goalId, taskId,
        content: `Question "${q.question}" answered: ${q.user_choice || '(skipped)'}`,
        fromUid, fromName: 'User',
        type: 'node',
      });
    }
  }

  return { ok: true, task_id: taskId, question_id: questionId, updated: true };
}

module.exports = {
  sendFeedback, notifyUser, sendDecisionAnswer,
  isPmIdle, getPmUid,
};

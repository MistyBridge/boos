// AutoPilot Engine — autonomous goal execution loop for supervisor agents.
//
// When a goal is activated (POST /api/goals/:id/activate), the PM session
// enters AutoPilot mode. This module provides:
//   - Pure utility functions for the AutoPilot loop
//   - AUTOPILOT_PROMPT: injected into the PM's system prompt to guide behavior
//   - Progress tracking + OpenViking integration
//
// Lines: ≤300

'use strict';

// ── Pure functions (no side effects, testable) ──────────────────────────────

/** Find tasks whose dependencies are all completed and status is 'pending'. */
function findReadyTasks(goal) {
  const tasks = goal.tasks || [];
  return tasks.filter((t) => {
    if (t.status !== 'pending') return false;
    if (!t.depends_on || t.depends_on.length === 0) return true;
    return t.depends_on.every((depId) => {
      const dep = tasks.find((x) => x.task_id === depId);
      return dep && dep.status === 'completed';
    });
  });
}

/** Check if a task's result satisfies the referenced acceptance criteria. */
function validateTaskResult(task, acceptanceCriteria, resultText) {
  if (!task.acceptance_criteria || task.acceptance_criteria.length === 0) return { ok: true };
  const acs = acceptanceCriteria || [];
  const refs = task.acceptance_criteria.map((ref) => acs.find((a) => a.id === ref)).filter(Boolean);
  if (refs.length === 0) return { ok: true, note: 'no matching AC found' };

  const text = (resultText || '').toLowerCase();
  const passed = [];
  const failed = [];
  for (const ac of refs) {
    // Simple heuristic: if result mentions key terms from the AC text, count as passed.
    // For rigorous validation, the PM should do a semantic check.
    const keywords = ac.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matchCount = keywords.filter((kw) => text.includes(kw)).length;
    const threshold = Math.max(1, Math.floor(keywords.length * 0.4));
    if (matchCount >= threshold) {
      passed.push(ac.id);
    } else {
      failed.push(ac.id);
    }
  }
  return { ok: failed.length === 0, passed, failed, threshold_met: passed.length >= refs.length * 0.5 };
}

/** Auto-mark milestones whose task_ids are all completed. */
function checkAndMarkMilestones(goal) {
  const tasks = goal.tasks || [];
  const milestones = goal.milestones || [];
  const newlyReached = [];
  for (const m of milestones) {
    if (m.reached) continue;
    if (!m.task_ids || m.task_ids.length === 0) continue;
    const allDone = m.task_ids.every((tid) => {
      const t = tasks.find((x) => x.task_id === tid);
      return t && t.status === 'completed';
    });
    if (allDone) {
      m.reached = true;
      m.reached_at = new Date().toISOString();
      newlyReached.push(m);
    }
  }
  return newlyReached;
}

/** Check if all tasks are completed and all acceptance criteria verified. */
function isGoalComplete(goal) {
  const tasks = goal.tasks || [];
  const allTasksDone = tasks.every((t) => t.status === 'completed');
  if (!allTasksDone) return false;
  const acsAllVerified = (goal.acceptance_criteria || []).every((a) => a.verified !== false);
  return acsAllVerified;
}

/** Generate a progress report suitable for OpenViking and user display. */
function generateProgressReport(goal) {
  const tasks = goal.tasks || [];
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const dispatched = tasks.filter((t) => t.status === 'dispatched').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const milestones = (goal.milestones || []).map((m) => ({
    id: m.id, title: m.title, reached: m.reached,
  }));
  return {
    goal_id: goal.goal_id,
    title: goal.title,
    status: goal.status,
    progress: `${completed}/${tasks.length}`,
    breakdown: { completed, dispatched, blocked, pending },
    milestones,
    acceptance_criteria: (goal.acceptance_criteria || []).map((a) => ({ id: a.id, text: a.text, verified: a.verified })),
  };
}

/** Determine the next action for the AutoPilot loop. */
function nextAction(goal) {
  if (!goal || goal.status === 'completed') return { action: 'done', reason: 'Goal completed' };
  if (goal.status === 'draft') return { action: 'activate', reason: 'Goal is draft' };

  const ready = findReadyTasks(goal);
  if (ready.length > 0) {
    // Sort: blocked tasks first (retry), then by dependency depth (shallow first)
    const depth = (t) => (t.depends_on || []).length;
    ready.sort((a, b) => {
      if (a.status === 'blocked' && b.status !== 'blocked') return -1;
      if (b.status === 'blocked' && a.status !== 'blocked') return 1;
      return depth(a) - depth(b);
    });
    return { action: 'dispatch', tasks: ready.slice(0, 5) }; // max 5 per wave
  }

  const hasBlocked = goal.tasks.some((t) => t.status === 'blocked');
  const hasDispatched = goal.tasks.some((t) => t.status === 'dispatched');
  if (hasDispatched) return { action: 'wait', reason: 'Tasks dispatched, awaiting completions' };
  if (hasBlocked) return { action: 'blocked', reason: 'All remaining tasks are blocked — waiting for decision answers' };
  return { action: 'stall', reason: 'No ready tasks and none dispatched — possible DAG deadlock' };
}

// ── AutoPilot Mode System Prompt ───────────────────────────────────────────

const AUTOPILOT_PROMPT = `
# BOOS AutoPilot Mode — Autonomous Execution

You are in **AutoPilot mode**. A goal has been activated and you must drive it to completion WITHOUT human intervention.

## Core Rule: NEVER BLOCK, NEVER WAIT FOR HUMANS
- When you encounter ambiguity → make a decision autonomously
- When you need a human decision → use \`request_decision\` WITHOUT \`blocking_task_id\`
- Decision results arrive asynchronously — you DO NOT wait for them
- Blocked tasks stay marked \`blocked\` — the loop skips them and continues
- If ALL remaining tasks are blocked → report to OpenViking and pause (human will unblock)

## AutoPilot Loop (run continuously until goal complete)

\`\`\`
1. call check_inbox to collect any task completions
2. For each completion:
   a. Find the matching task in the active goal
   b. Validate the result against acceptance criteria
   c. If valid → mark task completed, check milestones
   d. If invalid → send revision request to agent, keep task dispatched
3. Call findReadyTasks(goal) — get next wave of pending tasks
4. For each ready task:
   a. Match to agent by assignee or capabilities
   b. send_task with clear instructions + acceptance criteria
   c. Mark task as dispatched, save to goalStore.updateTask()
5. If no ready tasks and all dispatched → wait for next check_inbox
6. If all tasks complete → run final verification → mark goal completed
\`\`\`

## Validation Protocol
- After each task completion, validate the result against the task's acceptance criteria
- If uncertain, have the 可靠性工程师 cross-validate
- Failed validations → send revision request with specific feedback
- 3 failed attempts → mark task blocked, request_decision (non-blocking)

## Progress Tracking
- After each task completion, write progress snapshot to OpenViking: \`remember("AutoPilot progress: " + report)\`
- After each milestone reached, write milestone summary
- On goal completion, write final report with all AC verification results

## Signals
- \`check_inbox\` returns immediately (event-driven, zero polling)
- \`wake_agent\` auto-fires when tasks complete (you don't need to call it)
- Decision approvals arrive as regular tasks in your inbox
`;

module.exports = {
  findReadyTasks,
  validateTaskResult,
  checkAndMarkMilestones,
  isGoalComplete,
  generateProgressReport,
  nextAction,
  AUTOPILOT_PROMPT,
};
// ~170 lines

// PMO (Project Management Office) Engine — Sprint 31 Phase 4.
//
// The PMO is the PM's workload partner and failover. It monitors workspace
// health, tracks PM responsiveness, and escalates to the human decision
// area when the PM is unresponsive.
//
// Sprint 36: Polling is now done by BOOS code layer (autoSupervisor.js),
// not by agent-driven pmo_poll MCP tools. All agent polling mechanisms
// have been removed per the zero-polling event-driven architecture.
//
// Integration: autoSupervisor.js → pmoEngine.poll(workspace)
//
// Design constraints:
//   - Leaf module — no circular deps. Only requires store + dagStore +
//     notificationsWake (which itself is a leaf).
//   - Stateless except for _pmFailures in-memory tracking (reset on restart).
//   - All data persisted through store/dagStore; this module only reads.

'use strict';

const store = require('./store');
const dagStore = require('./dagStore');
const errReport = require("../errorReport");

// ── PM failure tracking (in-memory, reset on server restart) ────────────
// Keyed by PM uid. Tracks consecutive polls where PM was unresponsive.
// After 2 consecutive failures, escalation is triggered.

const _pmFailures = new Map(); // uid → { consecutive, lastPoll, escalated }

const PM_FAILURE_THRESHOLD = 2;  // consecutive polls before escalation
const UNRESPONSIVE_CUTOFF_MS = 10 * 60 * 1000; // 10 min — agent considered stale

// ── agent classification ────────────────────────────────────────────────

function _isStale(lastSeenAt) {
  if (!lastSeenAt) return true;
  return Date.now() - new Date(lastSeenAt).getTime() > UNRESPONSIVE_CUTOFF_MS;
}

function _classifyAgent(agent) {
  const stale = _isStale(agent.last_seen_at);
  const activeTasks = store.listActiveTasks(agent.uid);
  const hasInProgress = activeTasks.some((t) => t.status === 'in_progress');

  if (stale) return 'unresponsive';
  if (hasInProgress || activeTasks.length > 0) return 'busy';
  return 'idle';
}

// ── escalation ───────────────────────────────────────────────────────────

async function _escalatePMFailure(pmUid, pmName, workspace, consecutiveFailures) {
  const taskId = store.genTaskId();
  const content = [
    '## PM 故障升级 — PM 连续无响应',
    `- **PM**: ${pmName} (${pmUid})`,
    `- **Workspace**: ${workspace}`,
    `- **连续无响应次数**: ${consecutiveFailures}`,
    `- **触发阈值**: ${PM_FAILURE_THRESHOLD}`,
    '',
    'PM 在连续多次 PMO 健康轮询中无响应。请人类决策:',
    '- 手动 `wake_agent` 唤醒 PM',
    '- `set_pm` 指定新的 PM',
    '- 手动接管 DAG 任务审批',
  ].join('\n');

  try {
    await store.insertTask({
      task_id: taskId,
      sender_uid: 'system',
      sender_name: 'PMO Engine',
      sender_intro: 'PMO 自动故障检测',
      receiver_uid: store.ROOT_UID,
      content,
      priority: 'high',
      status: 'pending',
      reply_to: null,
      required_capabilities: [],
      matched_via: 'pmo_escalation',
      created_at: new Date().toISOString(),
    });
    return { escalated: true, escalation_task_id: taskId };
  } catch (e) {
    return { escalated: true, escalation_error: e.message };
  }
}

// ── main poll ────────────────────────────────────────────────────────────

/**
 * Poll workspace health. Called by BOOS code layer (autoSupervisor.js).
 *
 * Returns structured report: agent statuses, PM responsiveness, escalated
 * task count, and whether an escalation was triggered this cycle.
 *
 * @param {string} workspace
 * @returns {{ ok, workspace, timestamp, agents, pm_status, escalated_tasks, escalation_triggered }}
 */
async function poll(workspace) {
  const allAgents = store.listAllAgents().filter((a) => a.workspace === workspace);
  if (allAgents.length === 0) {
    return { ok: false, error: `no agents in workspace "${workspace}"` };
  }

  const now = new Date().toISOString();

  // Classify every agent.
  const agents = allAgents.map((a) => {
    const status = _classifyAgent(a);
    const activeTasks = store.listActiveTasks(a.uid);
    return {
      uid: a.uid,
      name: a.name,
      role: a.role || 'worker',
      status,
      active_tasks: activeTasks.length,
      last_seen_at: a.last_seen_at || null,
      unresponsive: a.unresponsive || false,
    };
  });

  // PM status tracking.
  const supervisors = agents.filter((a) => a.role === 'supervisor');
  const pmStatuses = supervisors.map((pm) => {
    const prev = _pmFailures.get(pm.uid) || { consecutive: 0, lastPoll: null, escalated: false };

    if (pm.status === 'unresponsive') {
      const consecutive = prev.consecutive + 1;
      const escalated = consecutive >= PM_FAILURE_THRESHOLD && !prev.escalated;
      _pmFailures.set(pm.uid, { consecutive, lastPoll: now, escalated: escalated || prev.escalated });
      return { uid: pm.uid, name: pm.name, responsive: false, consecutive_failures: consecutive, escalated_this_cycle: escalated };
    } else {
      // PM responded — reset failure count.
      _pmFailures.set(pm.uid, { consecutive: 0, lastPoll: now, escalated: false });
      return { uid: pm.uid, name: pm.name, responsive: true, consecutive_failures: 0, escalated_this_cycle: false };
    }
  });

  // Count escalated DAG tasks across all DAGs in workspace.
  let escalatedTaskCount = 0;
  let escalatedTasks = [];
  try {
    const dags = dagStore.listDags(workspace);
    for (const dag of dags) {
      const tasks = dagStore.getTasksByStatus(dag.dag_id, 'escalated');
      escalatedTaskCount += tasks.length;
      for (const t of tasks) {
        escalatedTasks.push({
          task_id: t.task_id,
          dag_id: t.dag_id,
          title: t.title,
          executor_uid: t.executor_uid,
          retry_count: t.retry_count || 0,
        });
      }
    }
  } catch (e) { errReport.report("pmoEngine", "push", e); }

  // Trigger escalation for newly-failed PMs.
  const escalationResults = [];
  for (const ps of pmStatuses) {
    if (ps.escalated_this_cycle) {
      const result = await _escalatePMFailure(ps.uid, ps.name, workspace, ps.consecutive_failures);
      escalationResults.push({ pm_uid: ps.uid, ...result });
    }
  }

  // Idle/busy/unresponsive counts.
  const counts = { total: agents.length, idle: 0, busy: 0, unresponsive: 0 };
  for (const a of agents) {
    if (counts[a.status] !== undefined) counts[a.status]++;
  }

  // All workers idle?
  const workers = agents.filter((a) => a.role !== 'supervisor' && a.role !== 'pmo');
  const allWorkersIdle = workers.length > 0 && workers.every((w) => w.status === 'idle');

  return {
    ok: true,
    workspace,
    timestamp: now,
    counts,
    agents,
    pm_status: pmStatuses,
    escalated_tasks: {
      count: escalatedTaskCount,
      tasks: escalatedTasks,
    },
    escalation_triggered: escalationResults.length > 0,
    escalation_results: escalationResults.length > 0 ? escalationResults : undefined,
    all_workers_idle: allWorkersIdle,
    hint: allWorkersIdle
      ? `All ${workers.length} workers are idle. PM may want to check for new work.`
      : `${counts.busy} agent(s) busy, ${counts.idle} idle, ${counts.unresponsive} unresponsive.`,
  };
}

/**
 * Reset PM failure tracking (e.g. when PM is explicitly woken by human).
 */
function resetPMFailures(pmUid) {
  _pmFailures.delete(pmUid);
}

/**
 * Get current PM failure counts (for debugging/dashboard).
 */
function getPMFailureStatus() {
  const result = {};
  for (const [uid, state] of _pmFailures) {
    result[uid] = { ...state };
  }
  return result;
}

module.exports = { poll, resetPMFailures, getPMFailureStatus };

// Auto-Supervisor — background polling loop that detects stalled projects
// and wakes the PM when all workers are idle but tasks remain unfinished.
//
// Runs in the BOOS server process (code layer), not in any agent. This is
// more reliable than agent-based polling because:
//   - No agent crash / PTY disconnect can break the loop
//   - No dependency on PMO agent registration or wake cycle
//   - Deterministic: the BOOS process IS the supervisor
//
// Integration: started/stopped by notifications.js alongside other
// background services (heartbeat, stale-reclaimer, task-timeout).
//
// Design:
//   - Leaf module — only requires store + dagStore + notificationsWake.
//   - Stateless except for in-memory debounce maps (reset on restart).
//   - All data read from store/dagStore; no direct mutation.

'use strict';

const store = require('./store');
const inboxStore = require('./inboxStore');
const dagStore = require('./dagStore');
const collaborationLoop = require('./collaborationLoop');

// ── configuration ─────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.BOOS_AUTO_SUPERVISOR_INTERVAL_MS, 10) || 5 * 60 * 1000;

// ── state ─────────────────────────────────────────────────────────────────

let _timer = null;
let _started = false;

// Debounce: one wake per workspace per interval.
const _lastWakeByWs = new Map();     // workspace → timestamp
const _lastSummaryHash = new Map();  // workspace → hash (skip if unchanged)

// ── lifecycle ─────────────────────────────────────────────────────────────

function start() {
  if (_started) return;
  _started = true;
  _scheduleNext();
  console.log('[boos] auto-supervisor started (interval=' + (POLL_INTERVAL_MS / 60000) + 'min)');
}

function stop() {
  _started = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function _scheduleNext() {
  if (!_started) return;
  _timer = setTimeout(async () => {
    try { await _pollAll(); } catch (e) { console.warn('[boos] auto-supervisor error:', e.message); }
    _scheduleNext();
  }, POLL_INTERVAL_MS);
  _timer.unref();
}

// ── main poll ─────────────────────────────────────────────────────────────

async function _pollAll() {
  // Discover workspaces from agent records.
  const db = store._syncLoad();
  const workspaces = new Set();
  for (const a of Object.values(db.agents)) {
    if (a.workspace && a.workspace !== '*') workspaces.add(a.workspace);
  }
  for (const ws of workspaces) {
    try { await _checkWorkspace(ws); } catch (e) { /* skip — don't block other workspaces */ }
  }
}

async function _checkWorkspace(workspace) {
  // Layer 1: Workspace-level master toggle.
  try {
    const wsConfig = require('../workspaceConfig');
    if (!(await wsConfig.isAutoSupervisorEnabled(workspace))) return;
  } catch {}

  // Layer 2: Folder-level toggle — if every folder used by this workspace's
  // agents has autoSupervisorEnabled=false, skip the workspace entirely.
  // This allows users to disable supervision per-folder without touching
  // the workspace-level master switch.
  try {
    const allFolders = await require('../folders').loadAll();
    const disabledFolders = new Set(
      allFolders.filter((f) => f.autoSupervisorEnabled === false).map((f) => f.id),
    );
    if (disabledFolders.size > 0) {
      const persistedSessions = require('../persistedSessions');
      const sessions = await persistedSessions.loadAll();
      // Map: folderId -> sessions in that folder
      const folderSessionMap = new Map();
      for (const s of sessions) {
        if (!s.folderId || s.deletedAt) continue;
        if (!folderSessionMap.has(s.folderId)) folderSessionMap.set(s.folderId, []);
        folderSessionMap.get(s.folderId).push(s);
      }
      // Sprint 33: uid may be the session ID itself or a legacy agent_xxx.
      // Try direct session lookup first, then fall back to identity card.
      const agents = store.listAllAgents().filter((a) => a.workspace === workspace);
      const agentFolderIds = new Set();
      for (const a of agents) {
        // Fast path: uid IS a session ID (legacy sess-xxx agents).
        const sess = sessions.find((s) => s.id === a.uid && !s.deletedAt);
        if (sess?.folderId) { agentFolderIds.add(sess.folderId); continue; }
        // Sprint 33: PG adapter is authoritative for UUID→session mapping.
        try {
          const adapter = require('../identityAdapter');
          const resolved = await adapter.resolve(a.uid);
          if (resolved?.sessions?.length) {
            for (const sid of resolved.sessions) {
              const s = sessions.find((s) => s.id === sid && !s.deletedAt);
              if (s?.folderId) agentFolderIds.add(s.folderId);
            }
          }
        } catch {}
      }
      // If ALL agent folders (non-empty) are disabled, skip.
      if (agentFolderIds.size > 0) {
        const allDisabled = [...agentFolderIds].every((fid) => disabledFolders.has(fid));
        if (allDisabled) return;
      }
    }
  } catch {}

  const all = store.listAllAgents().filter((a) => a.workspace === workspace);
  if (all.length === 0) return;

  const pms = all.filter((a) => a.role === 'supervisor');
  const workers = all.filter((a) => a.role !== 'supervisor' && a.role !== 'pmo' && a.role !== 'root');
  if (pms.length === 0 || workers.length === 0) return;

  // ── classify every worker ──────────────────────────────────────────
  const workerStates = await Promise.all(workers.map(async (w) => {
    const clState = await collaborationLoop.getAgentState(w.uid);
    // Sprint 35: read from per-agent inbox file (tiny ~few KB).
    const inbox = inboxStore.loadInboxSync(w.uid);
    const pending = inbox.pending.length;
    const inProgress = inbox.in_progress.length;
    return {
      uid: w.uid, name: w.name,
      state: clState.state,
      pending, inProgress,
      lastSeen: w.last_seen_at || null,
    };
  }));

  // ── check: all workers idle? ───────────────────────────────────────
  const allIdle = workerStates.every((w) => w.state === 'idle');
  if (!allIdle) return; // someone is working — nothing to flag

  // ── count unfinished work ──────────────────────────────────────────
  let pendingTotal = 0, inProgressTotal = 0;
  for (const w of workerStates) {
    pendingTotal += w.pending;
    inProgressTotal += w.inProgress;
  }

  // DAG tasks: count ALL unfinished statuses, not just escalated.
  // pending=blocked on dep, active=ready not started, submitted=awaiting review,
  // escalated=needs PM decision.  approved/cancelled are terminal.
  const DAG_UNFINISHED = new Set(['pending', 'active', 'submitted', 'escalated']);
  let dagUnfinishedTotal = 0;
  let escalatedTotal = 0;
  let escalatedTasks = [];
  let dagUnfinishedTasks = []; // all unfinished for summary
  try {
    const dags = dagStore.listDags(workspace);
    for (const dag of dags) {
      const allDagTasks = Object.values((store._syncLoad()).dag_tasks || {})
        .filter((t) => t.dag_id === dag.dag_id);
      for (const t of allDagTasks) {
        if (DAG_UNFINISHED.has(t.status)) {
          dagUnfinishedTotal++;
          dagUnfinishedTasks.push({
            task_id: t.task_id, dag_id: t.dag_id, title: t.title,
            executor_uid: t.executor_uid, status: t.status,
            retry_count: t.retry_count || 0,
          });
          if (t.status === 'escalated') {
            escalatedTotal++;
            escalatedTasks.push({
              task_id: t.task_id, dag_id: t.dag_id, title: t.title,
              executor_uid: t.executor_uid, retry_count: t.retry_count || 0,
            });
          }
        }
      }
    }
  } catch {}

  const totalUnfinished = pendingTotal + inProgressTotal + dagUnfinishedTotal;
  if (totalUnfinished === 0) return; // nothing to do

  // ── debounce: same workspace, same summary hash = skip ─────────────
  const summaryHash = _hashSummary(workerStates, pendingTotal, inProgressTotal, dagUnfinishedTasks);
  if (summaryHash === _lastSummaryHash.get(workspace)) return;

  const lastWake = _lastWakeByWs.get(workspace) || 0;
  if (Date.now() - lastWake < POLL_INTERVAL_MS) return;

  _lastWakeByWs.set(workspace, Date.now());
  _lastSummaryHash.set(workspace, summaryHash);

  // ── build structured summary ───────────────────────────────────────
  const summary = _buildSummary(workspace, workerStates, pendingTotal, inProgressTotal, dagUnfinishedTasks);

  // ── wake each PM ───────────────────────────────────────────────────
  for (const pm of pms) {
    await _wakePM(pm, workspace, summary);
  }
}

// ── summary builder ───────────────────────────────────────────────────────

function _buildSummary(workspace, workerStates, pending, inProgress, dagUnfinishedTasks) {
  const now = new Date().toISOString();

  // Group DAG tasks by status for concise display.
  const byStatus = {};
  for (const t of dagUnfinishedTasks) {
    if (!byStatus[t.status]) byStatus[t.status] = [];
    byStatus[t.status].push(t);
  }
  const escalated = byStatus['escalated'] || [];
  const active = byStatus['active'] || [];
  const submitted = byStatus['submitted'] || [];
  const pendingDag = byStatus['pending'] || [];

  const lines = [
    '## Auto-Supervisor: 项目组停滞检测',
    '',
    `**检测时间**: ${now}`,
    `**Workspace**: ${workspace}`,
    '',
    '### 未完成任务',
    `- pending: ${pending} (等待接收方 check_inbox)`,
    `- in_progress: ${inProgress} (可能卡住，超过阈值将自动回收)`,
    `- DAG active: ${active.length} (等待执行)`,
    `- DAG submitted: ${submitted.length} (等待审批)`,
    `- DAG pending: ${pendingDag.length} (等待依赖)`,
    `- DAG escalated: ${escalated.length} (需 PM 决策)`,
    '',
  ];

  function _formatDagTaskList(tasks, maxShow) {
    for (const t of tasks.slice(0, maxShow)) {
      const shortUid = t.executor_uid ? t.executor_uid.slice(-8) : '?';
      lines.push(`- \`${t.task_id}\` ${t.title} (执行: ${shortUid}, 重试 ${t.retry_count} 次)`);
    }
    if (tasks.length > maxShow) lines.push(`- ... 及其他 ${tasks.length - maxShow} 个 DAG 任务`);
  }

  if (escalated.length > 0) {
    lines.push('### DAG 升级任务 (需 PM 决策)');
    _formatDagTaskList(escalated, 10);
    lines.push('');
  }
  if (active.length > 0) {
    lines.push('### DAG 待执行任务 (active)');
    _formatDagTaskList(active, 5);
    lines.push('');
  }
  if (submitted.length > 0) {
    lines.push('### DAG 待审批任务 (submitted)');
    _formatDagTaskList(submitted, 5);
    lines.push('');
  }
  if (pendingDag.length > 0) {
    lines.push('### DAG 阻塞任务 (pending — 等待依赖)');
    _formatDagTaskList(pendingDag, 5);
    lines.push('');
  }

  lines.push('### Agent 状态');
  for (const w of workerStates) {
    const seen = w.lastSeen ? Math.round((Date.now() - new Date(w.lastSeen).getTime()) / 60000) : '?';
    lines.push(`- **${w.name}**: idle | pending:${w.pending} in_progress:${w.inProgress} | 最后活跃: ${seen} 分钟前`);
  }

  lines.push('');
  lines.push('### 建议操作');
  if (pending > 0) lines.push('- `wake_agent` 唤醒对应 worker 处理 pending 任务');
  if (inProgress > 0) lines.push('- 检查 in_progress 任务是否卡住 → `interrupt_task` 或 `cancel_task`');
  if (active.length > 0) lines.push('- `dag_wake_agent` 唤醒 executor 开始执行 DAG active 任务');
  if (submitted.length > 0) lines.push('- `wake_agent` 唤醒 reviewer 审批 DAG submitted 任务');
  if (escalated.length > 0) lines.push('- 查看 escalated DAG 任务 → `dag_status` → `dag_reassign_task` 或 `dag_approve_task`');
  if (pendingDag.length > 0) lines.push('- 检查 pending DAG 任务的依赖是否已完成 → `dag_status` 查看 DAG 图');
  lines.push('- 如无新任务可派发 → `dag_create` 创建下一批 Sprint 任务');

  return lines.join('\n');
}

function _hashSummary(workerStates, pending, inProgress, dagUnfinishedTasks) {
  // Simple deterministic hash — only need to detect "changed since last poll".
  const parts = [
    String(pending), String(inProgress), String(dagUnfinishedTasks.length),
    ...workerStates.map((w) => `${w.uid}:${w.state}:${w.pending}:${w.inProgress}`),
    ...dagUnfinishedTasks.map((t) => `${t.task_id}:${t.status}`),
  ];
  return parts.join('|');
}

// ── wake PM ───────────────────────────────────────────────────────────────

async function _wakePM(pm, workspace, summary) {
  // 1. Insert summary as a task in PM's inbox.
  const taskId = store.genTaskId();
  try {
    await store.insertTask({
      task_id: taskId,
      sender_uid: 'system',
      sender_name: 'BOOS Auto-Supervisor',
      sender_intro: '代码层自动停滞检测 — 非 agent 驱动',
      receiver_uid: pm.uid,
      content: summary,
      priority: 'high',
      status: 'pending',
      reply_to: null,
      required_capabilities: [],
      matched_via: 'auto_supervisor',
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[boos] auto-supervisor: failed to insert summary task for', pm.name, e.message);
    return;
  }

  // 2. Wake PM via dual-channel (SSE + PTY injection).
  try {
    const wakeMod = require('./notificationsWake');
    const result = await wakeMod.wakeAgent(pm.uid, {
      urgency: 'urgent',
      sender_name: 'BOOS Auto-Supervisor',
      message: `项目组停滞 — ${workspace} 有未完成任务但全员 idle。请检查 inbox。`,
    });
    console.log('[boos] auto-supervisor: woke PM', pm.name,
      result.ok ? '(SSE:' + result.sse_delivered + ' PTY:' + result.pty_delivered + ')' : '(failed)');
  } catch (e) {
    console.warn('[boos] auto-supervisor: wake PM failed for', pm.name, e.message);
  }
}

// ── status (for dashboard / debugging) ────────────────────────────────────

function getStatus() {
  return {
    started: _started,
    interval_ms: POLL_INTERVAL_MS,
    last_wakes: Object.fromEntries(_lastWakeByWs),
  };
}

module.exports = { start, stop, getStatus };

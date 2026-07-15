// Agent Hard Constraints Engine — Sprint 12 R15.
//
// Enforces behavioral rules at the agent-bus layer to eliminate
// meaningless interaction friction. All MCP request_decision calls
// pass through evaluate() before creating decision cards.
//
// Six constraint rules:
//   C1  Auto-continue       — "是否继续?" type questions → auto-reject
//   C2  Error auto-retry    — same error, retries ≤ 2 → auto-retry
//   C3  Clear error auto-fix — ENOENT/missing dep → auto-fix
//   C4  Real blocker only   — everything else → normal decision flow
//   C5  Concurrency cap     — max 3 in_progress per agent
//   C6  Quiet period merge  — max 3 decisions per 10min per agent

'use strict';

const store = require('./store');

// ── C5: per-agent concurrency cap ────────────────────────────────────

const MAX_IN_PROGRESS = 3;

// ── C6: per-agent decision rate tracking ─────────────────────────────

const _decisionTimestamps = new Map(); // uid → [timestamp, ...]
const DECISION_WINDOW_MS = 10 * 60_000;   // 10 min
const DECISION_MAX_IN_WINDOW = 3;

// ── C2: error retry tracking ─────────────────────────────────────────

const _errorAttempts = new Map(); // key: "uid::task_id::error_type" → count

// ── Public API ────────────────────────────────────────────────────────

/**
 * Evaluate whether an agent action should be allowed, blocked, or auto-decided.
 *
 * @param {'request_decision'} action
 * @param {{ content: string, agent_uid: string, task_id?: string,
 *            retry_count?: number, error_type?: string }} context
 * @returns {{ pass: boolean, reason?: string, auto_action?: 'reject'|'retry',
 *             rule?: string, merge_group?: string }}
 */
function evaluate(action, context) {
  if (action !== 'request_decision') return { pass: true };

  const { content, agent_uid: uid, task_id, retry_count, error_type } = context;
  const text = String(content || '');

  // ── C1: Auto-continue ──────────────────────────────────
  // If the agent is asking "should I continue?" or similar
  // confirmation, auto-reject the decision.
  const c1 = _matchC1(text);
  if (c1) {
    return {
      pass: false,
      reason: 'C1: auto-continue — 此类确认无需人类决策',
      auto_action: 'reject',
      rule: 'C1',
    };
  }

  // ── C2: Auto-retry on same error ───────────────────────
  if (error_type && task_id && uid && (retry_count || 0) <= 2) {
    const key = uid + '::' + task_id + '::' + error_type;
    const attempts = (_errorAttempts.get(key) || 0) + 1;
    _errorAttempts.set(key, attempts);
    if (attempts <= 2) {
      return {
        pass: false,
        reason: 'C2: 错误重试 #' + attempts + ' — ' + error_type,
        auto_action: 'retry',
        rule: 'C2',
      };
    }
  }

  // ── C3: Clear error auto-fix ───────────────────────────
  const c3 = _matchC3(text);
  if (c3) {
    return {
      pass: false,
      reason: 'C3: 清晰错误可自动修复 — ' + c3.type,
      auto_action: 'reject',  // reject decision, agent fixes directly
      rule: 'C3',
    };
  }

  // ── C6: Quiet period merge ─────────────────────────────
  if (uid) {
    _recordDecisionTime(uid);
    const inWindow = _countInWindow(uid);
    if (inWindow > DECISION_MAX_IN_WINDOW) {
      return {
        pass: true,
        merge_group: uid + '::' + _windowKey(),
        rule: 'C6',
        reason: 'C6: 静默期合并 — 此决策与最近 ' + inWindow + ' 个决策合并为批量卡片',
      };
    }
  }

  // ── C4: Real blocker — pass through ────────────────────
  return { pass: true, rule: 'C4' };
}

/**
 * Check whether an agent can accept another task (C5 concurrency cap).
 *
 * @param {string} uid
 * @returns {{ can_accept: boolean, reason?: string,
 *             in_progress_count: number, pending_count: number, max: number }}
 */
function checkLimits(uid) {
  const tasks = store.listMyTasks(uid);
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;

  if (inProgress >= MAX_IN_PROGRESS) {
    return {
      can_accept: false,
      reason: 'C5: 已达并发上限 (' + inProgress + '/' + MAX_IN_PROGRESS + ')',
      in_progress_count: inProgress,
      pending_count: pending,
      max: MAX_IN_PROGRESS,
    };
  }

  return {
    can_accept: true,
    in_progress_count: inProgress,
    pending_count: pending,
    max: MAX_IN_PROGRESS,
  };
}

/**
 * Get constraint status for all agents in a workspace.
 *
 * @param {string} workspace
 * @returns {Array<{ uid: string, name: string, in_progress: number,
 *            pending: number, max: number, can_accept: boolean,
 *            blocked_rules: string[] }>}
 */
function workspaceStatus(workspace) {
  const agents = store.listAgentsInWorkspace(workspace);
  return agents.map((a) => {
    const limits = checkLimits(a.uid);
    const blocked = [];
    if (!limits.can_accept) blocked.push('C5');
    return {
      uid: a.uid,
      name: a.name,
      in_progress: limits.in_progress_count,
      pending: limits.pending_count,
      max: limits.max,
      can_accept: limits.can_accept,
      blocked_rules: blocked,
    };
  });
}

// ── Internal matchers ──────────────────────────────────────────────────

// C1: "should I continue?" / "是否继续" / "要不要" / "还要不要"
const C1_PATTERNS = [
  /(?:是否|要不要|还要不要|还要|是否还要|是否可以|能否).*(?:继续|下一步|接着)/,
  /(?:should|could|can|may)\s+(?:I|we)\s+(?:continue|proceed|go\s+on)/i,
  /(?:继续|下一步|接着).*(?:吗|么|呢|吗？|么？|呢？)/,
  /(?:继续|下一步).*[?？]$/m,
  /(?:还要|还要不要|是否).*[?？]$/m,
  /^.*(?:可以继续|能继续|要停止|要中断).*[?？]$/m,
];

function _matchC1(text) {
  return C1_PATTERNS.some((re) => re.test(text));
}

// C3: errors with clear fix paths
const C3_PATTERNS = [
  { re: /ENOENT|file not found|no such file/i, type: 'missing_file' },
  { re: /cannot find module|cannot resolve/i, type: 'missing_dependency' },
  { re: /EACCES|permission denied/i, type: 'permission' },
  { re: /syntax[ _]?error|unexpected token/i, type: 'syntax' },
  { re: /undefined is not a function|is not a function/i, type: 'type_error' },
  { re: /ECONNREFUSED|connect ECONNREFUSED/i, type: 'connection' },
];

function _matchC3(text) {
  for (const p of C3_PATTERNS) {
    if (p.re.test(text)) return p;
  }
  return null;
}

// ── C6 helpers ─────────────────────────────────────────────────────────

function _recordDecisionTime(uid) {
  if (!_decisionTimestamps.has(uid)) _decisionTimestamps.set(uid, []);
  _decisionTimestamps.get(uid).push(Date.now());
  // Prune old entries.
  const cutoff = Date.now() - DECISION_WINDOW_MS;
  _decisionTimestamps.set(uid, _decisionTimestamps.get(uid).filter((t) => t > cutoff));
}

function _countInWindow(uid) {
  const ts = _decisionTimestamps.get(uid);
  if (!ts) return 0;
  const cutoff = Date.now() - DECISION_WINDOW_MS;
  return ts.filter((t) => t > cutoff).length;
}

function _windowKey() {
  const d = new Date();
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0') + String(d.getHours()).padStart(2, '0')
    + String(Math.floor(d.getMinutes() / 10) * 10).padStart(2, '0');
}

// ── C7: Write permission gate (Sprint 13.2) ────────────────────────────
// Non-write agents can only create/edit .md/.markdown/.txt/.json/.yaml files.
// Code files (.js/.ts/.py/.java etc.) are blocked.

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.r',
  '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.vue', '.svelte',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
]);

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.log']);

/**
 * Check if an agent can write to a file path (C7).
 * Non-write agents can only create/edit document-type files.
 *
 * @param {string} agentUid
 * @param {{ hasWritePermission: boolean, filePath: string, operation: string }} ctx
 * @returns {{ pass: boolean, reason?: string, rule?: string }}
 */
function checkWriteGate(agentUid, { hasWritePermission, filePath, operation }) {
  if (hasWritePermission !== false) return { pass: true };

  const ext = require('path').extname(filePath || '').toLowerCase();
  if (!ext || DOC_EXTENSIONS.has(ext)) return { pass: true };

  if (CODE_EXTENSIONS.has(ext)) {
    return {
      pass: false,
      reason: 'C7: 无写权限 — 只能创建/编辑 .md 文档文件，不能修改 ' + ext + ' 代码文件',
      rule: 'C7',
    };
  }

  // Unknown extension — allow (conservative).
  return { pass: true };
}

module.exports = { evaluate, checkLimits, workspaceStatus, checkWriteGate, MAX_IN_PROGRESS };

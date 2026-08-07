// Agent-Bus Unified Authorization Module — Sprint 36
//
// Single source of truth for all MCP tool authorization checks.
// Replaces 4 scattered duplicates of _requireSupervisor / _requirePMorPMO
// across handlers.js, handlersAdmin.js, handlersDag.js, and taskSystem.js.
//
// Design principles:
//   1. All auth functions return {error: string}|null — never throw.
//      Callers can return the error object directly to the MCP client.
//   2. requireRegistered is the base gate — every auth check starts here.
//   3. Supervisor is the universal override (except for PMO-specific ops).

'use strict';

const store = require('./store');
const errReport = require("../errorReport");

// ── role lookup ────────────────────────────────────────────────────────────

/** @returns {string|null} role name ('worker','supervisor','pmo') or null if unregistered */
function getRole(uid) {
  const agent = store.getAgent(uid);
  if (!agent) return null;
  return agent.role || 'worker';
}

/** @returns {object|null} agent record or null */
function getAgent(uid) {
  return store.getAgent(uid) || null;
}

// ── base gates ─────────────────────────────────────────────────────────────

/** Every authenticated tool must pass this first. */
function requireRegistered(ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  return null;
}

/** Supervisor-only operations. */
function requireSupervisor(ctx) {
  const base = requireRegistered(ctx);
  if (base) return base;
  const role = getRole(ctx.uid);
  if (role !== 'supervisor') {
    return { error: 'supervisor role required', role: role || 'unknown' };
  }
  return null;
}

/** PM (supervisor) or PMO operations (DAG creation, activation, cancellation). */
function requirePMorPMO(ctx) {
  const base = requireRegistered(ctx);
  if (base) return base;
  const role = getRole(ctx.uid);
  if (role !== 'supervisor' && role !== 'pmo') {
    return { error: 'PM (supervisor) or PMO role required', role: role || 'unknown' };
  }
  return null;
}

/** ROOT (human) only — for user-facing gates like starting/pausing Goals. */
function requireRoot(ctx) {
  const base = requireRegistered(ctx);
  if (base) return base;
  const ROOT_UID = store.ROOT_UID;
  if (ctx.uid !== ROOT_UID) {
    return { error: 'ROOT (user) role required — only the human operator can perform this action', uid: ctx.uid.slice(-8) };
  }
  return null;
}

/** Project-scoped PM: supervisor OR agent assigned as PM of the given project. */
function requireProjectPM(ctx, project) {
  const base = requireRegistered(ctx);
  if (base) return base;
  const agent = store.getAgent(ctx.uid);
  if (!agent) return { error: 'agent record not found — re-register' };
  const role = agent.role || 'worker';
  if (role === 'supervisor') return null; // supervisor always qualifies
  if (store.isPMOf(agent, project)) return null;
  return { error: 'supervisor or project PM role required', role };
}

// ── participation checks ───────────────────────────────────────────────────

/** Whether uid is sender OR receiver of a task. */
function isParticipant(uid, task) {
  if (!uid || !task) return false;
  return task.sender_uid === uid || task.receiver_uid === uid;
}

/** Whether uid is the sender of a task. */
function isSender(uid, task) {
  if (!uid || !task) return false;
  return task.sender_uid === uid;
}

/** Whether uid is the receiver of a task. */
function isReceiver(uid, task) {
  if (!uid || !task) return false;
  return task.receiver_uid === uid;
}

// ── workspace boundary ─────────────────────────────────────────────────────

/** Reject cross-workspace operations. */
function requireSameWorkspace(ctx, targetWorkspace) {
  const base = requireRegistered(ctx);
  if (base) return base;
  if (targetWorkspace && ctx.workspace && targetWorkspace !== ctx.workspace) {
    return { error: 'cannot operate across workspaces' };
  }
  return null;
}

// ── audit log ──────────────────────────────────────────────────────────────

/**
 * Record a supervisor-sensitive operation for audit trail.
 * Logs to console; future: write to ~/.boos/agent-bus/audit.jsonl.
 */
function audit(uid, action, detail) {
  const entry = {
    ts: new Date().toISOString(),
    uid: uid ? uid.slice(-8) : '?',
    action,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
  };
  console.log('[agent-bus:audit]', entry.ts, entry.uid, entry.action, entry.detail);
}

module.exports = {
  getRole, getAgent,
  requireRegistered, requireSupervisor, requirePMorPMO, requireProjectPM, requireRoot,
  isParticipant, isSender, isReceiver,
  requireSameWorkspace,
  audit,
};

// BOOS MCP Server tools — Sprint 35 Phase 2.
//
// Export BOOS state to external MCP Clients via standard MCP protocol.
// All tools require an authenticated session (ctx.uid must be non-null).
//
// Tool list:
//   boos.list_sessions  — list all persisted sessions
//   boos.get_session    — single session detail with PTY + agent binding
//   boos.list_workspaces — list workspace directories with repo status

'use strict';

const persistedSessions = require('../persistedSessions');
const { loadConfig } = require('../config');
const { listWorkspaces } = require('../workspace');

// ── helpers ────────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  return null;
}

function _safeSession(s) {
  return {
    id: s.id,
    cliId: s.cliId,
    cwd: s.cwd,
    workspace: s.workspace,
    title: s.title,
    status: s.status,
    cliSessionId: s.cliSessionId || null,
    projectSlug: s.projectSlug || null,
    agentUid: s.agentUid || null,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  };
}

// ── boos.list_sessions ─────────────────────────────────────────────────────

async function _listSessions(args, ctx) {
  const auth = _requireAuth(ctx);
  if (auth) return auth;

  let sessions;
  try {
    sessions = await persistedSessions.loadAll();
  } catch (e) {
    return { error: 'failed to load sessions: ' + e.message };
  }

  const { status, cliId, workspace, limit } = args || {};
  let filtered = sessions.filter(s => !s.deletedAt);

  if (status) filtered = filtered.filter(s => s.status === status);
  if (cliId) filtered = filtered.filter(s => s.cliId === cliId);

  // Default sort: newest first by lastActiveAt.
  filtered.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

  if (typeof limit === 'number' && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  return {
    total: sessions.length,
    returned: filtered.length,
    sessions: filtered.map(_safeSession),
  };
}

// ── boos.get_session ───────────────────────────────────────────────────────

async function _getSession(args, ctx) {
  const auth = _requireAuth(ctx);
  if (auth) return auth;

  const { session_id } = args || {};
  if (!session_id) return { error: 'session_id is required' };

  let session;
  try {
    session = await persistedSessions.get(session_id);
  } catch (e) {
    return { error: 'failed to load session: ' + e.message };
  }
  if (!session) return { error: 'session not found: ' + session_id };

  // PTY status from webTerminal.
  let ptyStatus = null;
  try {
    const webTerminal = require('../webTerminal');
    const term = webTerminal.get(session_id);
    if (term) {
      ptyStatus = {
        alive: !term.exitedAt,
        pid: term.meta ? term.meta.pid : null,
        attached: term.attached || 0,
      };
    }
  } catch { /* webTerminal unavailable */ }

  // Agent-bus binding from store (current MCP session → agent UID).
  let agentBinding = null;
  try {
    const store = require('./store');
    const boundUid = store.getSessionAgentUid(session.cliSessionId);
    if (boundUid) {
      const agent = store.getAgent(boundUid);
      agentBinding = agent
        ? { uid: boundUid, name: agent.name, workspace: agent.workspace, role: agent.role }
        : { uid: boundUid, name: null, workspace: null, role: null };
    }
  } catch { /* store unavailable */ }

  return {
    id: session.id,
    cliId: session.cliId,
    cwd: session.cwd,
    workspace: session.workspace,
    title: session.title,
    folderId: session.folderId,
    repos: session.repos,
    status: session.status,
    cliSessionId: session.cliSessionId || null,
    projectSlug: session.projectSlug || null,
    agentUid: session.agentUid || null,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    exitedAt: session.exitedAt,
    exitCode: session.exitCode,
    pid: session.pid,
    manualStopped: session.manualStopped || false,
    pty: ptyStatus,
    agent_binding: agentBinding,
  };
}

// ── boos.list_workspaces ───────────────────────────────────────────────────

async function _listWorkspaces(args, ctx) {
  const auth = _requireAuth(ctx);
  if (auth) return auth;

  let workDir, repos;

  try {
    const cfg = await loadConfig();
    workDir = cfg.workDir;
    repos = cfg.repos || [];
  } catch {
    // Fallback to defaults.
    const { DEFAULTS } = require('../config');
    workDir = DEFAULTS.workDir;
    repos = [];
  }

  // Gather busy paths from running sessions.
  let busyPaths = [];
  try {
    const sessions = await persistedSessions.loadAll();
    busyPaths = sessions
      .filter(s => s.status === 'running' && s.cwd)
      .map(s => s.cwd);
  } catch {}

  let workspaces;
  try {
    workspaces = await listWorkspaces({ workDir, repos, busyPaths });
  } catch (e) {
    return { error: 'failed to list workspaces: ' + e.message };
  }

  return { workDir, workspaces };
}

module.exports = { _listSessions, _getSession, _listWorkspaces };

// BOOS Folder Sandbox — filesystem path isolation for agent workspaces.
//
// Sprint 11: Each session folder can be bound to a rootPath. All agents
// in that folder are restricted to that directory for filesystem operations.
// PM/supervisor agents bypass the sandbox (unrestricted access).
//
// Usage:
//   const sandbox = require('./sandbox');
//   if (!sandbox.isAllowed(agentUid, sessionId, filePath)) {
//     throw new Error('sandbox: path outside folder boundary');
//   }

'use strict';

const path = require('path');
const folders = require('./folders');
const persistedSessions = require('./persistedSessions');
const store = require('./agentBus/store');

/**
 * Check if an agent is allowed to access a file path.
 * PM/supervisor agents always pass. Non-PM agents are restricted to
 * their folder's rootPath (if set).
 *
 * @param {string} agentUid — agent-bus agent UID
 * @param {string} filePath — absolute path being accessed
 * @returns {Promise<{allowed: boolean, reason?: string, rootPath?: string}>}
 */
async function isAllowed(agentUid, filePath) {
  // PM/supervisor always passes.
  if (await _isPM(agentUid)) return { allowed: true };

  // Resolve the agent's folder → rootPath.
  const rootPath = await _resolveRootPath(agentUid);

  // No rootPath set → no sandbox, allow.
  if (!rootPath) return { allowed: true };

  // Normalize both paths for comparison.
  const normalizedTarget = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootPath);

  // Check if target is within root.
  const relative = path.relative(normalizedRoot, normalizedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      allowed: false,
      reason: 'path "' + filePath + '" is outside sandbox "' + normalizedRoot + '"',
      rootPath: normalizedRoot,
    };
  }

  return { allowed: true, rootPath: normalizedRoot };
}

/**
 * Resolve the sandbox root path for an agent based on their session's folder.
 */
async function _resolveRootPath(agentUid) {
  try {
    // Find the agent's BOOS session via agent-bus sessions table.
    const sessionId = store.getSessionByAgentUid(agentUid);
    if (!sessionId) return null;

    // Get the session record.
    const session = await persistedSessions.findById(sessionId);
    if (!session) return null;

    // Get the session's folder.
    const folderId = session.folderId;
    if (!folderId) return null;

    // Get folder rootPath.
    return folders.getRootPath(folderId);
  } catch {
    return null;
  }
}

/**
 * Check if an agent is a PM or supervisor (sandbox bypass).
 * Checks: global role → agent-bus pm_of → folder-level agentLevels.
 */
async function _isPM(uid) {
  try {
    const agent = store.getAgent(uid);
    if (!agent) return false;
    // Global PM (supervisor role or explicit pm_of).
    if (agent.role === 'supervisor') return true;
    if (agent.pm_of && agent.pm_of.length > 0) return true;
    // Sprint 13.1: folder-level PM via agentLevels.
    const folderId = await _resolveFolderId(uid);
    if (folderId) {
      const levels = await folders.getAgentLevels(folderId);
      // Sprint 13.1 fix: getAgentLevels normalizes to { sandbox, write } objects.
      // Strict 'PM' string comparison is always false — check .sandbox property.
      if (levels[uid] && levels[uid].sandbox === 'PM') return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Resolve an agent's folder ID (extracted from _resolveRootPath).
async function _resolveFolderId(agentUid) {
  try {
    const sessionId = store.getSessionByAgentUid(agentUid);
    if (!sessionId) {
      // Try identity card fallback.
      const identity = store.getIdentity({ uid: agentUid });
      if (!identity?.boos_session_id) return null;
      const session = await persistedSessions.findById(identity.boos_session_id);
      return session?.folderId || null;
    }
    const session = await persistedSessions.findById(sessionId);
    return session?.folderId || null;
  } catch {
    return null;
  }
}

/**
 * Sprint 13.2: Check if an agent has write permission (can edit code files).
 * Non-write agents can only create/edit .md files.
 */
async function getWritePermission(agentUid) {
  try {
    const folderId = await _resolveFolderId(agentUid);
    if (!folderId) return true; // no folder → default allow
    const level = await folders.getAgentLevel(folderId, agentUid);
    return level.write !== false;
  } catch {
    return true; // on error, default allow
  }
}

/**
 * Sprint 13.2: Check if an agent can write to a specific file path.
 * Non-write agents can only write .md / .markdown files.
 */
async function canWriteCodeFile(agentUid, filePath) {
  const ext = require('path').extname(filePath || '').toLowerCase();
  const docExts = ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml'];
  if (docExts.includes(ext)) return { allowed: true }; // docs always allowed

  const hasWrite = await getWritePermission(agentUid);
  if (!hasWrite) {
    return {
      allowed: false,
      reason: 'agent lacks write permission — can only create/edit .md files',
    };
  }
  return { allowed: true };
}

/**
 * Generate the filesystem MCP server args for an agent session.
 * Non-PM agents with a folder rootPath get restricted to that path;
 * PM/supervisor agents and agents without a bound rootPath get PROJECT_ROOT.
 *
 * @param {{ folderId?: string, agentUid?: string }} opts
 * @returns {Promise<{ command: string, args: string[] }>}
 */
async function getFilesystemMcpConfig(opts = {}) {
  const { folderId, agentUid } = opts;
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const FS_SERVER = path.join(__dirname, '..', 'claudes', '.mcp', 'filesystem', 'dist', 'index.js');

  // PM/supervisor always gets full project access.
  if (agentUid && await _isPM(agentUid)) {
    return { command: 'node', args: [FS_SERVER, PROJECT_ROOT] };
  }

  // Non-PM agent with a bound folder rootPath → sandbox to that path.
  if (folderId) {
    const rootPath = await folders.getRootPath(folderId);
    if (rootPath) {
      return { command: 'node', args: [FS_SERVER, path.resolve(rootPath)] };
    }
  }

  // Default: full project access.
  return { command: 'node', args: [FS_SERVER, PROJECT_ROOT] };
}

module.exports = { isAllowed, getFilesystemMcpConfig, getWritePermission, canWriteCodeFile };

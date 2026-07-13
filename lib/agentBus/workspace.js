// Workspace namespace utilities.
// Validates workspace identifiers and extracts workspace names from file paths.
// A workspace name must be a non-empty alphanumeric string with hyphens/underscores.
//
// Copied from agent-bus/lib/workspace.js — zero changes needed.

'use strict';

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function validateWorkspace(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, reason: 'workspace name must be a non-empty string' };
  }
  if (name.length > 64) {
    return { valid: false, reason: 'workspace name too long (max 64 chars)' };
  }
  if (!WORKSPACE_NAME_RE.test(name)) {
    return { valid: false, reason: 'workspace name contains invalid characters' };
  }
  return { valid: true };
}

function extractWorkspace(cwd) {
  if (!cwd) return null;
  const normalized = cwd.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^ws-\d+$/.test(part)) return part;
    if (part === 'workspaces' && i + 1 < parts.length) return parts[i + 1];
  }
  return null;
}

module.exports = { validateWorkspace, extractWorkspace };

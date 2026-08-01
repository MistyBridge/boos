// Infrastructure MCP handlers — session launch, file locks, knowledge base,
// hard constraints engine, and root-agent messaging.
//
// Imported by handlers.js dispatch() for the corresponding switch cases.

'use strict';

// ── File lock handlers ──────────────────────────────────────────────────
//
// Sprint 33: All auth goes through session ID (ctx.uid === BOOS session ID).
// Validation chain: session ID → agent exists → sandbox boundary → write permission.

async function _requestFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — session ID required' };
  const fl = require('./fileLock');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);

  // Sprint 33: Require agent registration for file locks.
  if (!agent) {
    return { error: 'session not registered in agent-bus', hint: 'call register_agent first' };
  }

  // Sprint 32: Sandbox defense-in-depth — validate that the file path
  // is within the agent's allowed directories before granting a lock.
  // The MCP filesystem server enforces this at I/O time, but checking here
  // prevents agents from locking files they can't even access.
  if (args.file_path) {
    try {
      const sandbox = require('../sandbox');
      const check = await sandbox.isAllowed(ctx.uid, args.file_path);
      if (!check.allowed) {
        return { error: 'sandbox: ' + check.reason };
      }
      // Sprint 33: Also check write permission for code files.
      const writeCheck = await sandbox.canWriteCodeFile(ctx.uid, args.file_path);
      if (!writeCheck.allowed) {
        return { error: 'write permission denied: ' + writeCheck.reason };
      }
    } catch (e) {
      // sandbox module unavailable — non-fatal, fall through to lock layer.
    }
  }

  return fl.requestLock(ctx.uid, agent.name || ctx.uid, args.file_path);
}

async function _releaseFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.releaseLock(ctx.uid, args.file_path);
}

async function _listFileLocks(_args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  return fl.listLocks();
}

// ── Knowledge base handlers ─────────────────────────────────────────────

async function _updateKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);
  return kb.writeEntry(args.path, args.content, {
    append: args.append,
    author: agent ? agent.name : ctx.uid,
  });
}

async function _queryKnowledge(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const kb = require('../knowledgeBase');
  if (args.path) return kb.readEntry(args.path);
  if (args.query) return kb.search(args.query);
  return kb.listSection(args.section || null);
}

// ── Constraints engine handlers ─────────────────────────────────────────

async function _constraintsCheck(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return constraints.checkLimits(ctx.uid);
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

async function _constraintsStatus(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  try {
    const constraints = require('./constraints');
    return {
      workspace: ctx.workspace || 'boos',
      agents: constraints.workspaceStatus(ctx.workspace || 'boos'),
    };
  } catch (e) {
    return { error: 'constraints engine not available: ' + e.message };
  }
}

// ── Root agent ──────────────────────────────────────────────────────────

async function _sendToRoot(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const store = require('./store');
  const queue = require('./queue');
  const content = String(args.content || '').slice(0, 8192);
  if (!content.trim()) return { error: 'content is required' };

  const agent = store.getAgent(ctx.uid);
  const ROOT_UID = store.ROOT_UID;

  const r = await queue.sendTask({
    sender: { uid: ctx.uid, name: agent?.name || 'unknown', intro: agent?.intro || '', workspace: ctx.workspace || '' },
    receiver_uid: ROOT_UID,
    content,
    priority: args.priority || 'normal',
    reply_to: args.reply_to || undefined,
  });

  if (!r.ok) return { error: r.error };
  return { ok: true, task_id: r.task_id, hint: 'Message sent to BOOS Root. Responses delivered via SSE push + auto-wake — no polling needed.' };
}

module.exports = {
  _requestFileLock, _releaseFileLock, _listFileLocks,
  _updateKnowledge, _queryKnowledge,
  _constraintsCheck, _constraintsStatus,
  _sendToRoot,
};

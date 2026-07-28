// Infrastructure MCP handlers — session launch, file locks, knowledge base,
// hard constraints engine, and root-agent messaging.
//
// Imported by handlers.js dispatch() for the corresponding switch cases.

'use strict';

// ── File lock handlers ──────────────────────────────────────────────────

async function _requestFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);
  return fl.requestLock(ctx.uid, agent ? agent.name : ctx.uid, args.file_path);
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

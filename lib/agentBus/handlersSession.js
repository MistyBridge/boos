// Infrastructure MCP handlers — session launch, file locks, knowledge base,
// hard constraints engine, and root-agent messaging.
//
// Imported by handlers.js dispatch() for the corresponding switch cases.

'use strict';
const errReport = require('../errorReport');   // Sprint 42: no silent failures


// ── File lock handlers ──────────────────────────────────────────────────
//
// Sprint 36 redesign: agent requests a file lock without caring about
// file state or sandbox boundaries. BOOS handles all auth at the code
// layer (sandbox is enforced by MCP filesystem server at I/O time,
// write permissions by the supervisor routing table).
//
// When a file is locked by another agent → caller is queued FIFO and
// receives immediate "queued" response. When the lock is released,
// BOOS auto-grants to the next waiter and wakes them via SSE + PTY.

// Wire up the auto-notify callback so fileLock can wake waiters on release.
(function _wireFileLockAutoNotify() {
  try {
    const fl = require('./fileLock');
    fl.setOnGrantToWaiter((agentUid, filePath, holderName) => {
      // SSE notification
      try {
        const transport = require('./transport');
        transport.notifyAgent(agentUid, 'notifications/agent_bus/file_lock_granted', {
          file_path: filePath,
          message: `File lock granted: ${filePath}. You can now edit this file.`,
        });
      } catch (e) { errReport.report("handlersSession", "notifyAgent", e); }
      // PTY wake
      try {
        const notifications = require('./notifications');
        notifications.wakeAgent(agentUid, {
          urgency: 'urgent',
          message: `[FileLock] Lock granted for ${filePath}. Call request_file_lock again to claim it.`,
        }).catch(() => {});
      } catch (e) { errReport.report("handlersSession", "wakeAgent", e); }
    });
  } catch (e) { errReport.report("handlersSession", "wakeAgent", e); }
})();

async function _requestFileLock(args, ctx) {
  // Sprint 36: agent just requests the file. No sandbox checks —
  // the MCP filesystem server enforces directory boundaries at I/O time,
  // and write permission is governed by the supervisor routing table.
  // Sprint 42: same ctx identity resolution as send_task —
  // autoResolveIdentity in dispatch() fills uid from transport session,
  // and Router Mode uses header-based identity.  If both fail, a clear
  // "register_agent first" error is more accurate than "session ID required".
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const fl = require('./fileLock');
  const store = require('./store');
  const agent = store.getAgent(ctx.uid);

  if (!agent) {
    return { error: 'session not registered in agent-bus', hint: 'call register_agent first' };
  }

  return fl.requestLock(ctx.uid, agent.name || ctx.uid, args.file_path);
}

async function _releaseFileLock(args, ctx) {
  if (!ctx.uid) return { error: 'not registered' };
  const fl = require('./fileLock');
  const result = fl.releaseLock(ctx.uid, args.file_path);

  // If a waiter was auto-granted, notify + wake them.
  if (result.ok && result.next_holder) {
    try {
      const transport = require('./transport');
      transport.notifyAgent(result.next_holder, 'notifications/agent_bus/file_lock_granted', {
        file_path: args.file_path,
        message: `File lock granted: ${args.file_path}. You can now edit this file.`,
      });
    } catch (e) { errReport.report("handlersSession", "notifyAgent", e); }
    try {
      const notifications = require('./notifications');
      notifications.wakeAgent(result.next_holder, {
        urgency: 'urgent',
        message: `[FileLock] Lock granted for ${args.file_path}. Call request_file_lock again to claim it.`,
      }).catch(() => {});
    } catch (e) { errReport.report("handlersSession", "wakeAgent", e); }
    result.hint = 'Next waiter (' + result.next_holder_name + ') has been auto-granted and notified.';
  }

  return result;
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
  const errReport = require("../errorReport");
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

// Decision REST API — human review panel for agent decision requests.
//
// When a human approves/rejects a decision, the answer is auto-returned to the
// asking agent via agent-bus queue. This closes the agent→decision→human→agent loop.
//
// register(app, deps)
//   deps: { asyncH }

'use strict';

const decisionSystem = require('../lib/decisionSystem');

// Lazy-load agent-bus modules (avoid circular deps at startup).
let _queue = null;
function _getQueue() {
  if (!_queue) _queue = require('../lib/agentBus/queue');
  return _queue;
}

function register(app, { asyncH }) {
  // GET /api/decisions — list decisions
  app.get(
    '/api/decisions',
    asyncH(async (req, res) => {
      const status = req.query.status || 'open';
      const workspace = req.query.workspace || null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const result = decisionSystem.listDecisions({ workspace, status, limit });
      res.json(result);
    }),
  );

  // GET /api/decisions/:id — get full .md content
  app.get(
    '/api/decisions/:id',
    asyncH(async (req, res) => {
      const { metadata, markdown } = decisionSystem.getDecision(req.params.id);
      if (!metadata) return res.status(404).json({ error: 'Decision not found' });
      res.json({ ...metadata, content: markdown });
    }),
  );

  // POST /api/decisions/:id/approve
  app.post(
    '/api/decisions/:id/approve',
    asyncH(async (req, res) => {
      const approver = req.body?.approver || 'host';
      const comment = req.body?.comment || '';
      const r = decisionSystem.approveDecision(req.params.id, approver, comment);
      if (!r.ok) return res.status(400).json(r);

      // Auto-return the answer to the asking agent.
      await _notifyAgentOfDecision(r, 'approved', approver, comment);

      res.json(r);
    }),
  );

  // POST /api/decisions/:id/reject
  app.post(
    '/api/decisions/:id/reject',
    asyncH(async (req, res) => {
      const approver = req.body?.approver || 'host';
      const comment = req.body?.comment || '';
      const r = decisionSystem.rejectDecision(req.params.id, approver, comment);
      if (!r.ok) return res.status(400).json(r);

      // Auto-return the answer to the asking agent.
      await _notifyAgentOfDecision(r, 'rejected', approver, comment);

      res.json(r);
    }),
  );

  // POST /api/decisions/:id/reply — Sprint 9: inline reply from Decision Zone UI.
  app.post(
    '/api/decisions/:id/reply',
    asyncH(async (req, res) => {
      const body = req.body?.body || '';
      if (!body.trim()) return res.status(400).json({ error: 'body is required' });
      const approver = req.body?.approver || 'host';

      // Reply is stored as an approval-like action but with the reply text as comment.
      const r = decisionSystem.approveDecision(req.params.id, approver, body.trim());
      if (!r.ok) return res.status(400).json(r);

      // Auto-return the answer to the asking agent.
      await _notifyAgentOfDecision(r, 'replied', approver, body.trim());

      res.json(r);
    }),
  );

  // Sprint 13: POST /api/decisions/root-respond — human responds to a root agent task.
  // Completes the task via agent-bus, which triggers _onTaskCompleted and unblocks
  // the waiting agent's task.
  app.post(
    '/api/decisions/root-respond',
    asyncH(async (req, res) => {
      const { task_id, result } = req.body || {};
      if (!task_id) return res.status(400).json({ error: 'task_id is required' });
      if (!result) return res.status(400).json({ error: 'result is required' });

      const queue = _getQueue();
      const store = require('../lib/agentBus/store');
      const ROOT_UID = store.ROOT_UID;
      const r = await queue.respondTask(task_id, ROOT_UID, String(result).slice(0, 4096));
      if (!r.ok) return res.status(400).json(r);
      res.json({ ok: true, task_id });
    }),
  );
}

// ── Auto-respond to agent via agent-bus ────────────────────────────────

async function _notifyAgentOfDecision(result, status, approver, comment) {
  try {
    const { metadata } = decisionSystem.getDecision(result.decision_id);
    if (!metadata || !metadata.agent_uid) {
      console.warn('[decisions] cannot notify agent: no agent_uid in decision', result.decision_id);
      return;
    }
    const agentUid = String(metadata.agent_uid);
    const decisionTitle = metadata.title || result.decision_id;

    const statusLabel = status === 'approved' ? '✅ 已批准' : status === 'replied' ? '💬 已回复' : '❌ 已驳回';
    const answer = [
      `${statusLabel}: ${decisionTitle}`,
      `决策编号: ${result.decision_id}`,
      `审核人: ${approver}`,
      comment ? `回答: ${comment}` : '',
    ].filter(Boolean).join('\n');

    const queue = _getQueue();
    const store = require('../lib/agentBus/store');
    const ROOT_UID = store.ROOT_UID;
    const sender = {
      uid: ROOT_UID,
      name: 'BOOS Root',
      intro: '人类决策回复',
      workspace: '*',
    };

    const r = await queue.sendTask({
      sender,
      receiver_uid: agentUid,
      content: answer,
      priority: 'high',
      reply_to: result.decision_id,
    });

    if (r.ok) {
      console.log('[decisions] answer delivered to agent', agentUid, 'for decision', result.decision_id);
    } else {
      console.warn('[decisions] failed to deliver answer to agent', agentUid, ':', r.error);
    }

    // Sprint 9: auto-unblock the task that was waiting for this decision.
    const blockingTaskId = metadata.blocking_task_id;
    if (blockingTaskId) {
      try {
        const unblockResult = await queue.unblockTask(String(blockingTaskId));
        if (unblockResult.ok) {
          console.log('[decisions] unblocked task', blockingTaskId, 'for decision', result.decision_id);
        }
      } catch (e) {
        console.warn('[decisions] unblock error:', e.message);
      }
    }
  } catch (e) {
    console.warn('[decisions] auto-notify error:', e.message);
  }
}

module.exports = { register };

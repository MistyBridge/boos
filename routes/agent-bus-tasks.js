// Agent-Bus Task Query API — Sprint 17 A1 + A2.
//
// GET /api/agent-bus/tasks
//   ?status=pending&agent_uid=xxx&limit=50
// GET /api/agent-bus/tasks/:task_id
//
// Returns tasks from the agent-bus store, filtered by query params.
// Sorted by created_at descending. CORS: allows MistyBridge.github.io.
//
// register(app, deps)
//   deps: { asyncH }

'use strict';

const store = require('../lib/agentBus/store');

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'interrupted', 'exhausted', 'blocked', 'notification']);

function register(app, { asyncH }) {

  app.get('/api/agent-bus/tasks', asyncH(async (req, res) => {
    const statusFilter = String(req.query.status || '').toLowerCase();
    const agentUid = String(req.query.agent_uid || '').trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    // Validate status filter.
    if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
      return res.status(400).json({
        error: 'invalid status: "' + statusFilter + '". Valid: ' + Array.from(VALID_STATUSES).join(', '),
      });
    }

    // Read all tasks directly (read-only snapshot, no lock needed).
    // @stale-ok: read-only, no lock needed
    let tasks = [];
    try {
      // Replaced store._syncLoad() — not exported. Direct read is safe.
      const raw = require('fs').readFileSync(store.DB_PATH, 'utf-8');
      const db = JSON.parse(raw);
      tasks = Object.values(db.tasks || {});
    } catch {}

    // Apply filters.
    if (statusFilter) {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }
    if (agentUid) {
      tasks = tasks.filter((t) =>
        t.sender_uid === agentUid || t.receiver_uid === agentUid,
      );
    }

    // Sort by created_at descending.
    tasks.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    // Apply limit.
    const total = tasks.length;
    tasks = tasks.slice(0, limit);

    res.json({ tasks, total, limit, filters: { status: statusFilter || null, agent_uid: agentUid || null } });
  }));

  // ── A2: single task lookup ──────────────────────────────────────────
  app.get('/api/agent-bus/tasks/:task_id', asyncH(async (req, res) => {
    const taskId = String(req.params.task_id).trim();
    if (!taskId) {
      return res.status(400).json({ error: 'task_id is required' });
    }

    const task = store.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: 'task not found: ' + taskId });
    }

    res.json({ task });
  }));
}

module.exports = { register };

// Agent-Bus Task Query API — Sprint 35 (per-agent inbox, not shared store).
//
// GET /api/agent-bus/tasks
//   ?status=pending&agent_uid=xxx&limit=50
// GET /api/agent-bus/tasks/:task_id
//
// Reads from per-agent inbox files (~few KB each) instead of the old
// shared agent-bus.json (which was 1.16 MB and caused lock contention).

'use strict';

const fs = require('fs');
const path = require('path');
const inboxStore = require('../lib/agentBus/inboxStore');
const queue = require('../lib/agentBus/queue');

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'interrupted', 'exhausted', 'blocked', 'notification']);

function register(app, { asyncH }) {

  app.get('/api/agent-bus/tasks', asyncH(async (req, res) => {
    const statusFilter = String(req.query.status || '').toLowerCase();
    const agentUid = String(req.query.agent_uid || '').trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
      return res.status(400).json({
        error: 'invalid status: "' + statusFilter + '". Valid: ' + Array.from(VALID_STATUSES).join(', '),
      });
    }

    let tasks = [];

    if (agentUid) {
      // Fast path: read only ONE agent's inbox file (~few KB).
      try {
        const inbox = await inboxStore.loadInbox(agentUid);
        tasks = [...inbox.pending, ...inbox.in_progress];
        // For completed/cancelled, also scan archive.
        if (statusFilter && !['pending', 'in_progress', 'blocked'].includes(statusFilter)) {
          try {
            const archiveFile = inboxStore.archivePath(agentUid);
            const lines = (await require('fs/promises').readFile(archiveFile, 'utf-8'))
              .split('\n').filter(Boolean);
            for (const line of lines) {
              try { tasks.push(JSON.parse(line)); } catch {}
            }
          } catch {}
        }
      } catch { tasks = []; }
    } else {
      // Scan all inbox files in the inbox directory.
      try {
        const inboxDir = inboxStore.INBOX_DIR;
        const files = await require('fs/promises').readdir(inboxDir);
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const inbox = await inboxStore.loadInbox(f.replace('.json', ''));
            tasks.push(...inbox.pending, ...inbox.in_progress);
          } catch {}
        }
      } catch {}
    }

    // Filter, sort, limit.
    if (statusFilter) {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }
    if (agentUid) {
      tasks = tasks.filter((t) =>
        t.sender_uid === agentUid || t.receiver_uid === agentUid,
      );
    }
    tasks.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const total = tasks.length;
    tasks = tasks.slice(0, limit);

    res.json({ tasks, total, limit, filters: { status: statusFilter || null, agent_uid: agentUid || null } });
  }));

  // ── single task lookup ──────────────────────────────────────────────
  app.get('/api/agent-bus/tasks/:task_id', asyncH(async (req, res) => {
    const taskId = String(req.params.task_id).trim();
    if (!taskId) {
      return res.status(400).json({ error: 'task_id is required' });
    }

    // Use task index to find owner, then read their inbox.
    const ownerUid = queue._findTaskOwner(taskId);
    let task = null;
    if (ownerUid) {
      task = await inboxStore.getTask(ownerUid, taskId);
    }

    if (!task) {
      return res.status(404).json({ error: 'task not found: ' + taskId });
    }

    res.json({ task });
  }));
}

module.exports = { register };

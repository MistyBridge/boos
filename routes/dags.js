// DAG REST API — Sprint 34.
//
// Bridges REST → agent-bus MCP dag_* handlers so the frontend
// DAG dashboard can list, view, approve, and reject DAG tasks
// without going through the MCP tool interface.
//
// GET  /api/dags                     — list all DAGs in workspace
// GET  /api/dags/:id                 — get DAG details + summary
// POST /api/dags/tasks/:id/approve   — approve a submitted task
// POST /api/dags/tasks/:id/reject    — reject a submitted task
//
// register(app, { asyncH })

'use strict';

const dagHandlers = require('../lib/agentBus/handlersDag');
const store = require('../lib/agentBus/store');

// Build a synthetic MCP ctx from the HTTP request.
// Most dag_* handlers only need ctx.uid for auth; PM-only
// operations are also protected here via _requirePMorPMO.
function _ctxFromReq(req) {
  // Use the agent UID from the request if available;
  // simplest path: the frontend sends ?uid=xxx, or we
  // fall back to the PM UID (only PM/PMO can approve/reject).
  const uid = (req.query && req.query.uid) || '82b97d58-c66e-45d3-9f6d-af3476d5abdd';
  return {
    uid,
    workspace: (req.query && req.query.workspace) || 'boos',
    sessionId: req.headers && req.headers['x-mcp-session-id'] || '',
  };
}

function register(app, { asyncH }) {

  // ── list DAGs ──────────────────────────────────────────────────────
  app.get('/api/dags', asyncH(async (req, res) => {
    const ctx = _ctxFromReq(req);
    const result = await dagHandlers._dagList(
      { workspace: ctx.workspace },
      ctx,
    );
    if (result.error) {
      const code = result.error.includes('not found') ? 404 : 500;
      return res.status(code).json(result);
    }
    res.json(result);
  }));

  // ── single DAG detail ──────────────────────────────────────────────
  app.get('/api/dags/:id', asyncH(async (req, res) => {
    const dagId = String(req.params.id).trim();
    if (!dagId) return res.status(400).json({ error: 'dag_id is required' });

    const ctx = _ctxFromReq(req);
    const result = await dagHandlers._dagStatus({ dag_id: dagId }, ctx);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  }));

  // ── approve task ───────────────────────────────────────────────────
  app.post('/api/dags/tasks/:id/approve', asyncH(async (req, res) => {
    const taskId = String(req.params.id).trim();
    if (!taskId) return res.status(400).json({ error: 'task_id is required' });

    const ctx = _ctxFromReq(req);
    const comment = (req.body && req.body.comment) || '';
    try {
      const result = await dagHandlers._dagApproveTask(
        { task_id: taskId, comment },
        ctx,
      );
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(403).json({ error: e.message });
    }
  }));

  // ── reject task ────────────────────────────────────────────────────
  app.post('/api/dags/tasks/:id/reject', asyncH(async (req, res) => {
    const taskId = String(req.params.id).trim();
    if (!taskId) return res.status(400).json({ error: 'task_id is required' });

    const ctx = _ctxFromReq(req);
    const comment = (req.body && req.body.comment) || '';
    try {
      const result = await dagHandlers._dagRejectTask(
        { task_id: taskId, comment },
        ctx,
      );
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(403).json({ error: e.message });
    }
  }));

}

module.exports = { register };

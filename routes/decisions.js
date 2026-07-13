// Decision REST API — human review panel for agent decision requests.
// Replaces inline handlers in server.js.
//
// register(app, deps)
//   deps: { asyncH }

'use strict';

const decisionSystem = require('../lib/decisionSystem');

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
      const r = decisionSystem.approveDecision(req.params.id, req.body?.approver || 'host');
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    }),
  );

  // POST /api/decisions/:id/reject
  app.post(
    '/api/decisions/:id/reject',
    asyncH(async (req, res) => {
      const r = decisionSystem.rejectDecision(
        req.params.id,
        req.body?.approver || 'host',
        req.body?.comment || '',
      );
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    }),
  );
}

module.exports = { register };

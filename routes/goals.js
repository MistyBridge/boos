// Goal REST API — CRUD for AutoPilot goals.
//
// POST   /api/goals              — create goal (PM/supervisor only)
// GET    /api/goals              — list goals (?workspace=&status=)
// GET    /api/goals/:id          — single goal detail
// PUT    /api/goals/:id          — update goal fields
// DELETE /api/goals/:id          — delete goal
// POST   /api/goals/:id/activate — activate AutoPilot on this goal
// GET    /api/goals/summary      — workspace summary stats
//
// Lines: ≤300

'use strict';

const goalStore = require('../lib/goalStore');
const store = (() => { try { return require('../lib/agentBus/store'); } catch { return null; } })();

// ── helpers ────────────────────────────────────────────────────────────────

function _isSupervisor(req) {
  try {
    const agentUid = req.headers['x-agent-uid'] || '';
    if (!agentUid || !store) return false;
    const agent = store.getAgent(agentUid);
    return agent && agent.role === 'supervisor';
  } catch { return false; }
}

function _supervisorGate(req, res) {
  if (!_isSupervisor(req)) {
    return res.status(403).json({ error: 'supervisor only' });
  }
  return null; // pass
}

// ── register ───────────────────────────────────────────────────────────────

function register(app, { asyncH }) {

  // POST /api/goals — create goal
  app.post('/api/goals', asyncH(async (req, res) => {
    const blocked = _supervisorGate(req, res);
    if (blocked) return;

    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'title required' });
    if (!body.workspace) return res.status(400).json({ error: 'workspace required' });
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return res.status(400).json({ error: 'tasks array required (min 1 task)' });
    }

    try {
      const goal = await goalStore.createGoal(body);
      res.status(201).json({ ok: true, goal });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }));

  // GET /api/goals — list goals
  app.get('/api/goals', asyncH(async (req, res) => {
    const workspace = req.query.workspace || null;
    const status = req.query.status || null;
    const goals = await goalStore.listGoals({ workspace, status });
    res.json({ ok: true, goals, count: goals.length });
  }));

  // GET /api/goals/summary — workspace stats (must be before :id)
  app.get('/api/goals/summary', asyncH(async (req, res) => {
    const workspace = req.query.workspace || null;
    const s = await goalStore.summary(workspace);
    res.json({ ok: true, ...s });
  }));

  // GET /api/goals/:id — single goal
  app.get('/api/goals/:id', asyncH(async (req, res) => {
    const goal = await goalStore.getGoal(req.params.id);
    if (!goal) return res.status(404).json({ error: 'goal not found' });
    res.json({ ok: true, goal });
  }));

  // PUT /api/goals/:id — update goal
  app.put('/api/goals/:id', asyncH(async (req, res) => {
    const blocked = _supervisorGate(req, res);
    if (blocked) return;

    try {
      const goal = await goalStore.updateGoal(req.params.id, req.body || {});
      if (!goal) return res.status(404).json({ error: 'goal not found' });
      res.json({ ok: true, goal });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }));

  // DELETE /api/goals/:id
  app.delete('/api/goals/:id', asyncH(async (req, res) => {
    const blocked = _supervisorGate(req, res);
    if (blocked) return;

    const removed = await goalStore.deleteGoal(req.params.id);
    if (!removed) return res.status(404).json({ error: 'goal not found' });
    res.json({ ok: true, removed: true });
  }));

  // POST /api/goals/:id/activate — start AutoPilot
  app.post('/api/goals/:id/activate', asyncH(async (req, res) => {
    const blocked = _supervisorGate(req, res);
    if (blocked) return;

    try {
      const goal = await goalStore.activateGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'goal not found' });
      res.json({ ok: true, goal, hint: 'AutoPilot activated — PM will begin autonomous execution' });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }));
}

module.exports = { register };
// ~118 lines

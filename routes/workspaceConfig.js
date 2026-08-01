// Workspace configuration routes — PM/PMO assignment + auto-supervisor toggle.
//
// register(app, deps)
//   deps: { asyncH, workspaceConfig }

'use strict';

function register(app, { asyncH, workspaceConfig }) {

  // Sprint 33: GET /api/auth/permissions — unified session permissions query.
  // All platform authentication goes through session ID.
  // Query: ?sessionId=sess-xxx
  app.get('/api/auth/permissions', asyncH(async (req, res) => {
    const sessionId = req.query.sessionId || req.query.sessionid;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId query parameter is required' });
    }
    const perms = await workspaceConfig.getSessionPermissions(sessionId);
    if (perms.error) return res.status(404).json(perms);
    res.json(perms);
  }));

  // GET /api/workspace-config/:workspace — full config for one workspace.
  app.get('/api/workspace-config/:workspace', asyncH(async (req, res) => {
    const cfg = await workspaceConfig.get(req.params.workspace);
    res.json(cfg);
  }));

  // GET /api/workspace-config — all workspace configs.
  app.get('/api/workspace-config', asyncH(async (_req, res) => {
    const all = await workspaceConfig.getAll();
    res.json(all);
  }));

  // PUT /api/workspace-config/:workspace/pm — assign PM.
  app.put('/api/workspace-config/:workspace/pm', asyncH(async (req, res) => {
    const { uid } = req.body || {};
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ error: 'uid (agent UID) is required' });
    }
    const result = await workspaceConfig.setPM(req.params.workspace, uid);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  }));

  // DELETE /api/workspace-config/:workspace/pm — remove PM.
  app.delete('/api/workspace-config/:workspace/pm', asyncH(async (req, res) => {
    const result = await workspaceConfig.clearPM(req.params.workspace);
    res.json(result);
  }));

  // PUT /api/workspace-config/:workspace/pmo — assign PMO.
  app.put('/api/workspace-config/:workspace/pmo', asyncH(async (req, res) => {
    const { uid } = req.body || {};
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ error: 'uid (agent UID) is required' });
    }
    const result = await workspaceConfig.setPMO(req.params.workspace, uid);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  }));

  // DELETE /api/workspace-config/:workspace/pmo — remove PMO.
  app.delete('/api/workspace-config/:workspace/pmo', asyncH(async (req, res) => {
    const result = await workspaceConfig.clearPMO(req.params.workspace);
    res.json(result);
  }));

  // PUT /api/workspace-config/:workspace/auto-supervisor — toggle.
  app.put('/api/workspace-config/:workspace/auto-supervisor', asyncH(async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    const result = await workspaceConfig.setAutoSupervisor(req.params.workspace, enabled);
    res.json(result);
  }));
}

module.exports = { register };

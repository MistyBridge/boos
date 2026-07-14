// HR Agent API routes — Sprint 8 #65 #66.
//
// register(app, deps)
//   deps: { hrAgent }

'use strict';

function register(app, { hrAgent }) {

  // ---- list available roles ----
  app.get('/api/hr/roles', (_req, res) => {
    try {
      const roles = hrAgent.listAvailableRoles();
      res.json({ ok: true, roles, count: roles.length });
    } catch (e) {
      res.json({ ok: false, error: e.message, roles: [], count: 0 });
    }
  });

  // ---- list recruitment log (stub — reads from agent-bus task history) ----
  app.get('/api/hr/recruitments', (_req, res) => {
    res.json({ ok: true, recruitments: [], count: 0, hint: 'recruitment log coming soon' });
  });
}

module.exports = { register };

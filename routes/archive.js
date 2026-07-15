// Archive REST API — browse and restore archived tasks/decisions.
//
// register(app, deps)
//   deps: { asyncH }

'use strict';

const archive = require('../lib/archive');

function register(app, { asyncH }) {
  // GET /api/archive/:type — list archived items
  app.get(
    '/api/archive/:type',
    asyncH(async (req, res) => {
      const type = req.params.type;
      if (!['tasks', 'decisions'].includes(type)) {
        return res.status(400).json({ error: 'type must be "tasks" or "decisions"' });
      }
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const result = archive.listArchive(type, { limit, offset });
      res.json(result);
    }),
  );

  // GET /api/archive/:type/:id — get full archived item
  app.get(
    '/api/archive/:type/:id',
    asyncH(async (req, res) => {
      const item = archive.getArchivedItem(req.params.type, req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found in archive' });
      res.json(item);
    }),
  );

  // POST /api/archive/:type/:id/restore — restore archived item
  app.post(
    '/api/archive/:type/:id/restore',
    asyncH(async (req, res) => {
      const { ok, entry, error } = archive.restore(req.params.type, req.params.id);
      if (!ok) return res.status(404).json({ error });
      res.json({
        ok: true,
        type: entry.type,
        id: entry.id,
        data: entry.data,
        archived_at: entry.archived_at,
        hint: 'Item restored. Call DELETE to remove from archive after verifying recovery.',
      });
    }),
  );

  // DELETE /api/archive/:type/:id — permanently delete archived item
  app.delete(
    '/api/archive/:type/:id',
    asyncH(async (req, res) => {
      const result = archive.deleteArchived(req.params.type, req.params.id);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    }),
  );

  // POST /api/archive/prune — manually trigger prune (supervisor only)
  app.post(
    '/api/archive/prune',
    asyncH(async (_req, res) => {
      const result = archive.pruneExpired();
      res.json(result);
    }),
  );
}

module.exports = { register };

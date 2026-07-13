// Folder CRUD routes.
// Replaces inline handlers in server.js L668–703.
//
// register(app, deps)
//   deps: { asyncH, folders, persistedSessions }

'use strict';

function register(app, { asyncH, folders, persistedSessions }) {

  app.get('/api/folders', asyncH(async (_req, res) => {
    const list = await folders.loadAll();
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    res.json({ folders: list });
  }));

  app.post('/api/folders', asyncH(async (req, res) => {
    const name = req.body && req.body.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json({ folder: await folders.create({ name }) });
  }));

  app.put('/api/folders/:id', asyncH(async (req, res) => {
    const updated = await folders.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ folder: updated });
  }));

  app.delete('/api/folders/:id', asyncH(async (req, res) => {
    // Move all sessions in this folder to Unsorted before delete.
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.folderId === req.params.id) {
        await persistedSessions.setFolder(s.id, null);
      }
    }
    const removed = await folders.remove(req.params.id);
    res.json({ removed });
  }));

  app.post('/api/folders/reorder', asyncH(async (req, res) => {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
    const next = await folders.reorder(ids);
    res.json({ folders: next });
  }));
}

module.exports = { register };

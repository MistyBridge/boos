// Folder CRUD routes.
// Replaces inline handlers in server.js L668–703.
//
// register(app, deps)
//   deps: { asyncH, folders, persistedSessions }

'use strict';
const path = require('node:path');

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

  // Sprint 11: sandbox root-path binding for session folders.
  app.put('/api/folders/:id/root-path', asyncH(async (req, res) => {
    const { rootPath } = req.body || {};
    if (rootPath && typeof rootPath === 'string' && !path.isAbsolute(rootPath)) {
      return res.status(400).json({ error: 'rootPath must be an absolute path' });
    }
    const val = (rootPath === null || rootPath === '') ? null : rootPath;
    const updated = await folders.setRootPath(req.params.id, val);
    if (!updated) return res.status(404).json({ error: 'folder not found' });
    res.json({ folder: updated });
  }));

  // Sprint 13.1/13.2: agent permission levels per folder.
  // Accepts legacy string "PM"|"SE" OR new object { sandbox: "PM"|"SE", write: boolean }.
  app.put('/api/folders/:id/agent-levels', asyncH(async (req, res) => {
    const { levels } = req.body || {};
    if (levels && typeof levels !== 'object') {
      return res.status(400).json({ error: 'levels must be an object { uid: "PM"|"SE" | { sandbox, write } }' });
    }
    if (levels) {
      for (const [uid, lv] of Object.entries(levels)) {
        if (typeof lv === 'string') {
          if (lv !== 'PM' && lv !== 'SE') {
            return res.status(400).json({ error: 'invalid level "' + lv + '" for ' + uid + ' — must be "PM" or "SE"' });
          }
        } else if (typeof lv === 'object') {
          if (lv.sandbox && lv.sandbox !== 'PM' && lv.sandbox !== 'SE') {
            return res.status(400).json({ error: 'invalid sandbox "' + lv.sandbox + '" for ' + uid + ' — must be "PM" or "SE"' });
          }
          if (lv.write !== undefined && typeof lv.write !== 'boolean') {
            return res.status(400).json({ error: 'write must be boolean for ' + uid });
          }
        } else {
          return res.status(400).json({ error: 'invalid level type for ' + uid });
        }
      }
    }
    const updated = await folders.setAgentLevels(req.params.id, levels || {});
    if (!updated) return res.status(404).json({ error: 'folder not found' });
    res.json({ ok: true, folder: updated });
  }));
}

module.exports = { register };

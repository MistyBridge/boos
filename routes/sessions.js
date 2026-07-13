// Session CRUD routes.
// Replaces inline handlers in server.js — list, update, delete, restore,
// stop, switch-cli, open-editor, reorder, deleted.
//
// register(app, deps)
//   deps: { asyncH, persistedSessions, webTerminal, folders, loadConfig,
//           findCliById, spawnEnv }

'use strict';

function register(app, { asyncH, persistedSessions, webTerminal, folders, loadConfig, findCliById, spawnEnv }) {

  // ---- list ----
  app.get('/api/sessions', asyncH(async (_req, res) => {
    const list = await persistedSessions.loadAll();
    // Cross-check status against live PTY pool so a stale "running" record
    // doesn't survive a server restart.
    const live = new Set(webTerminal.list().filter((t) => !t.exitedAt).map((t) => t.id));
    for (const s of list) {
      if (s.status === 'running' && !live.has(s.id)) {
        s.status = 'exited';
      }
    }
    // Per-session activity probe (transcript mtime → working/idle).
    const cfg = await loadConfig();
    const cliById = new Map((cfg.clis || []).map((c) => [c.id, c]));
    const { probeActivity } = require('../lib/cliActivity');
    await Promise.all(list.map(async (s) => {
      if (s.status !== 'running') { s.activity = 'unknown'; return; }
      try { s.activity = await probeActivity(s, cliById.get(s.cliId)); }
      catch { s.activity = 'unknown'; }
    }));
    res.json({ sessions: list, takenAt: Date.now() });
  }));

  // ---- deleted ----
  app.get('/api/sessions/deleted', asyncH(async (_req, res) => {
    const list = await persistedSessions.loadDeleted();
    res.json({ sessions: list, takenAt: Date.now(), retentionMs: persistedSessions.DELETED_RETENTION_MS });
  }));

  // ---- update (rename / move folder) ----
  app.put('/api/sessions/:id', asyncH(async (req, res) => {
    const patch = {};
    if (typeof req.body.title === 'string') patch.title = req.body.title;
    if ('folderId' in (req.body || {})) patch.folderId = req.body.folderId || null;
    const updated = await persistedSessions.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ session: updated });
  }));

  // ---- switch-cli ----
  app.post('/api/sessions/:id/switch-cli', asyncH(async (req, res) => {
    const targetCliId = typeof req.body?.cliId === 'string' ? req.body.cliId.trim() : '';
    if (!targetCliId) return res.status(400).json({ error: 'cliId required' });

    const record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });

    const cfg = await loadConfig();
    const currentCli = findCliById(cfg, record.cliId);
    const targetCli = findCliById(cfg, targetCliId);
    if (!currentCli) return res.status(400).json({ error: `current CLI ${record.cliId} no longer configured` });
    if (!targetCli) return res.status(400).json({ error: `target CLI ${targetCliId} not configured` });

    if (record.cliId === targetCli.id) {
      const live = webTerminal.get(record.id);
      return res.json({ session: record, changed: false, running: !!(live && !live.exitedAt) });
    }

    const updated = await persistedSessions.update(record.id, { cliId: targetCli.id });
    const live = webTerminal.get(record.id);
    res.json({
      session: updated, changed: true,
      running: !!(live && !live.exitedAt),
      fromCliId: currentCli.id, toCliId: targetCli.id,
    });
  }));

  // ---- stop ----
  app.post('/api/sessions/:id/stop', asyncH(async (req, res) => {
    const record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });
    const stopped = webTerminal.kill(record.id);
    const updated = await persistedSessions.update(record.id, {
      status: 'exited', pid: null, exitCode: null,
      exitedAt: Date.now(), manualStopped: true, lastActiveAt: Date.now(),
    });
    try { require('../lib/cliActivity').releaseSession(record.id); } catch {}
    res.json({ stopped, session: updated });
  }));

  // ---- delete ----
  app.delete('/api/sessions/:id', asyncH(async (req, res) => {
    try { webTerminal.kill(req.params.id); } catch {}
    const removed = await persistedSessions.remove(req.params.id);
    try { require('../lib/cliActivity').releaseSession(req.params.id); } catch {}
    res.json({ removed });
  }));

  // ---- restore ----
  app.post('/api/sessions/:id/restore', asyncH(async (req, res) => {
    const deleted = (await persistedSessions.loadDeleted()).find((s) => s.id === req.params.id);
    if (!deleted) return res.status(404).json({ error: 'deleted session not found' });

    const folderList = await folders.loadAll();
    const validFolderIds = new Set(folderList.filter((f) => !f.builtin).map((f) => f.id));
    const restoreFolderId = validFolderIds.has(deleted.deletedFromFolderId)
      ? deleted.deletedFromFolderId : null;

    const restored = await persistedSessions.restore(req.params.id, { folderId: restoreFolderId });
    if (!restored) return res.status(404).json({ error: 'deleted session not found' });
    res.json({ session: restored });
  }));

  // ---- open-editor ----
  app.post('/api/sessions/:id/open-editor', asyncH(async (req, res) => {
    const record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });
    const cfg = await loadConfig();
    const editor = (cfg.editor || '').trim() || 'code';
    const { spawn } = require('node:child_process');
    try {
      const child = spawn(editor, [`"${record.cwd}"`], {
        detached: true, stdio: 'ignore', shell: true,
        env: spawnEnv(), windowsHide: true,
      });
      child.on('error', (e) => console.warn(`[boos] open-editor "${editor}" failed:`, e.message));
      child.unref();
      res.json({ ok: true, editor, cwd: record.cwd });
    } catch (e) {
      res.status(500).json({ error: `failed to launch ${editor}: ${e.message}` });
    }
  }));

  // ---- reorder ----
  app.post('/api/sessions/reorder', asyncH(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids) return res.status(400).json({ error: 'ids array required' });
    const folderId = req.body?.folderId ?? null;
    for (let i = 0; i < ids.length; i++) {
      try { await persistedSessions.update(ids[i], { folderId, order: i }); } catch {}
    }
    res.json({ ok: true, count: ids.length });
  }));
}

module.exports = { register };

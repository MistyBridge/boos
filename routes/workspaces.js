// Workspace + browse + layout routes.
// Replaces inline handlers in server.js — browse, workspaces CRUD, layout.
//
// register(app, deps)
//   deps: { asyncH, loadConfig, persistedSessions, listWorkspaces, isInside,
//           workspaceOccupancySessions, workspaceOccupancyLabel }

'use strict';

const path = require('node:path');
const os = require('node:os');

function register(app, { asyncH, loadConfig, persistedSessions, listWorkspaces, isInside, workspaceOccupancySessions, workspaceOccupancyLabel }) {

  // ---- directory browser ----
  app.get('/api/browse', asyncH(async (req, res) => {
    const fs = require('node:fs/promises');
    const target = req.query.path ? path.resolve(String(req.query.path)) : os.homedir();
    let entries = [];
    let exists = true;
    try {
      const list = await fs.readdir(target, { withFileTypes: true });
      entries = list
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      exists = false;
    }
    const parent = path.dirname(target);
    const cfg = await loadConfig();
    const starts = [
      { label: 'Home', path: os.homedir() },
      { label: 'Work dir', path: cfg.workDir },
    ];
    if (process.platform === 'win32') {
      for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
        const root = `${letter}:\\`;
        try { await fs.access(root); starts.push({ label: `${letter}:\\`, path: root }); }
        catch {}
      }
    }
    res.json({
      path: target,
      parent: parent === target ? null : parent,
      exists, entries, starts,
    });
  }));

  // ---- workspaces list ----
  app.get('/api/workspaces', asyncH(async (req, res) => {
    const cfg = await loadConfig();
    const allSess = await persistedSessions.loadAll();
    const occupying = workspaceOccupancySessions(allSess, cfg);
    const busyPaths = occupying.map((s) => s.cwd);
    const workspaces = await listWorkspaces({
      workDir: cfg.workDir, repos: cfg.repos, busyPaths,
    });
    for (const w of workspaces) {
      w.sessionsHere = occupying.filter((s) => isInside(s.cwd, w.path)).map((s) => s.id);
      w.inUse = w.sessionsHere.length > 0;
    }
    res.json({ workDir: cfg.workDir, repos: cfg.repos, workspaces });
  }));

  // ---- delete workspace ----
  app.delete('/api/workspaces/:name', asyncH(async (req, res) => {
    const fsp = require('node:fs/promises');
    const cfg = await loadConfig();
    const name = String(req.params.name || '');
    if (!name || /[\\/]|^\.\.$|^\.$/.test(name)) {
      return res.status(400).json({ error: 'invalid workspace name' });
    }
    const target = path.resolve(cfg.workDir, name);
    if (!isInside(target, cfg.workDir) || path.resolve(target) === path.resolve(cfg.workDir)) {
      return res.status(400).json({ error: 'workspace must live under workDir' });
    }
    try {
      const st = await fsp.stat(target);
      if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    } catch {
      return res.status(404).json({ error: 'workspace not found' });
    }
    const allSess = await persistedSessions.loadAll();
    const occupying = workspaceOccupancySessions(allSess, cfg);
    const inUse = occupying.some((s) => isInside(s.cwd, target));
    if (inUse) {
      return res.status(409).json({ error: `workspace is in use by a ${workspaceOccupancyLabel(cfg)}` });
    }
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  // ---- workspace layout (agent node canvas positions) ----
  app.get('/api/workspaces/:name/layout', asyncH(async (req, res) => {
    const name = String(req.params.name || '');
    if (!name || /[\\/]|^\.\.$|^\.$/.test(name)) return res.status(400).json({ error: 'invalid workspace name' });
    const cfg = await loadConfig();
    const fsmod = require('node:fs/promises');
    const layoutPath = path.resolve(cfg.workDir, name, '.boos', 'layout.json');
    try {
      const raw = await fsmod.readFile(layoutPath, 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.json({ agentPositions: {}, splitRatio: 0.5, version: 1 });
    }
  }));

  app.put('/api/workspaces/:name/layout', asyncH(async (req, res) => {
    const name = String(req.params.name || '');
    if (!name || /[\\/]|^\.\.$|^\.$/.test(name)) return res.status(400).json({ error: 'invalid workspace name' });
    const body = req.body || {};
    const cfg = await loadConfig();
    const fsp = require('node:fs/promises');
    const boosDir = path.resolve(cfg.workDir, name, '.boos');
    const layoutPath = path.join(boosDir, 'layout.json');
    try { await fsp.mkdir(boosDir, { recursive: true }); } catch {}
    let existing = { agentPositions: {}, splitRatio: 0.5, version: 1 };
    try {
      const raw = await fsp.readFile(layoutPath, 'utf-8');
      existing = JSON.parse(raw);
    } catch {}
    const merged = {
      ...existing,
      agentPositions: { ...existing.agentPositions, ...(body.agentPositions || {}) },
      splitRatio: typeof body.splitRatio === 'number' ? body.splitRatio : existing.splitRatio,
      version: (existing.version || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(layoutPath, JSON.stringify(merged, null, 2), 'utf-8');
    res.json(merged);
  }));
}

module.exports = { register };

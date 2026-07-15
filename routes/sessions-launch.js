// Session launch + resume + import + adopt routes.
// Replaces inline handlers in server.js — new, resume, resume-picker,
// cli-sessions, import-by-id, adopt.
//
// register(app, deps)
//   deps: { asyncH, loadConfig, saveConfig, DATA_DIR, pickCli, findCliById,
//           persistedSessions, webTerminal, sessionBinding, localCliSessions,
//           folders, listWorkspaces, findOrCreateWorkspace, ensureReposInWorkspace,
//           isInside, workspaceOccupancySessions, workspaceOccupancyLabel,
//           resolveCommand, spawnEnv, spawnCliSession,
//           scheduleBindingScan, scheduleBindingScanSeries,
//           launchCwdFor, spawnSessionRecord, spawnSessionPickerRecord,
//           codexThemeArgs, getState, pkg, os, path }

'use strict';

function register(app, deps) {
  const {
    asyncH, loadConfig, saveConfig, DATA_DIR, pickCli, findCliById,
    persistedSessions, webTerminal, localCliSessions, folders,
    listWorkspaces, findOrCreateWorkspace, ensureReposInWorkspace,
    isInside, workspaceOccupancySessions, workspaceOccupancyLabel,
    launchCwdFor, spawnSessionRecord, spawnSessionPickerRecord,
    getState,
  } = deps;

  const path = require('node:path');
  const os = require('node:os');

  // ── Rate limiters ────────────────────────────────────────────────────
  const { createRateLimiter } = require('../lib/rateLimiter');
  const newSessionLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  const resumeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

  // ---- new session ----
  // body: { cliId?, repos?, workspace?, folderId?, launch?: true }
  // Streams NDJSON: workspace / clone-* / launched / done.
  app.post('/api/sessions/new', newSessionLimiter, async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const emit = (obj) => { res.write(JSON.stringify(obj) + '\n'); };
    const fail = (msg, extra) => {
      emit({ type: 'done', success: false, error: msg, ...extra });
      res.end();
    };

    try {
      const cfg = await loadConfig();
      const cli = pickCli(cfg, req.body && req.body.cliId);
      if (!cli) return fail('No CLI configured. Add one in Configure → CLIs.');

      const explicitRepos = Array.isArray(req.body && req.body.repos);
      const wantedNames = explicitRepos
        ? req.body.repos
        : cfg.repos.filter((r) => r.defaultSelected).map((r) => r.name);
      const wantedRepos = cfg.repos.filter((r) => wantedNames.includes(r.name));
      if (wantedRepos.length === 0 && !explicitRepos && wantedNames.length > 0) {
        return fail('No matching repos found');
      }

      let workspace;
      let created = false;
      if (req.body && req.body.cwd) {
        const fsmod = require('node:fs/promises');
        const cwd = path.resolve(String(req.body.cwd));
        try {
          const st = await fsmod.stat(cwd);
          if (!st.isDirectory()) return fail(`${cwd} is not a directory`);
        } catch {
          return fail(`directory not found: ${cwd}`);
        }
        workspace = { name: path.basename(cwd) || cwd, path: cwd };
      } else if (req.body && req.body.workspace) {
        const allSess = await persistedSessions.loadAll();
        const busyPaths = workspaceOccupancySessions(allSess, cfg).map((s) => s.cwd);
        const all = await listWorkspaces({ workDir: cfg.workDir, repos: cfg.repos, busyPaths });
        workspace = all.find((w) => w.name === req.body.workspace);
        if (!workspace) return fail(`workspace ${req.body.workspace} not found`);
      } else {
        const allSess = await persistedSessions.loadAll();
        const busyPaths = workspaceOccupancySessions(allSess, cfg).map((s) => s.cwd);
        const r = await findOrCreateWorkspace({
          workDir: cfg.workDir, repos: cfg.repos, busyPaths, requireUnused: true,
        });
        workspace = r.workspace;
        created = r.created;
      }
      emit({ type: 'workspace', workspace, created });

      const launchCwd = launchCwdFor(workspace, wantedRepos, req.body && req.body.cwd);
      const shouldLaunch = req.body && req.body.launch !== false;

      const cloneResults = (req.body && req.body.cwd) ? [] : await ensureReposInWorkspace({
        workspacePath: workspace.path,
        repos: wantedRepos,
        onRepoStart: (repo) => emit({ type: 'clone-start', repo: repo.name, url: repo.url }),
        onProgress: (repo, p) => emit({ type: 'clone-progress', repo: repo.name, ...p }),
        onLine: (repo, line) => emit({ type: 'clone-line', repo: repo.name, line }),
        onRepoEnd: (repo, result) => emit({ type: 'clone-end', repo: repo.name, ...result }),
      });
      const failed = cloneResults.filter((r) => !r.ok);
      if (failed.length > 0) return fail('Some repos failed to clone', { cloneResults });

      // Auto-inject agent-bus MCP config + sandbox-aware filesystem.
      if (shouldLaunch) {
        const mcpPath = path.join(launchCwd, '.mcp.json');
        try {
          let existing = { mcpServers: {} };
          try {
            const raw = await require('node:fs/promises').readFile(mcpPath, 'utf-8');
            existing = JSON.parse(raw);
          } catch {}
          // Compute sandbox-aware filesystem config.
          const sandbox = require('../lib/sandbox');
          const fsConfig = await sandbox.getFilesystemMcpConfig({ folderId: body.folderId });
          const merged = {
            ...existing,
            mcpServers: {
              ...(existing.mcpServers || {}),
              'agent-bus': {
                type: 'sse',
                url: `http://127.0.0.1:${getState().currentPort}/mcp/sse`,
              },
              filesystem: fsConfig,
            },
          };
          await require('node:fs/promises').mkdir(path.dirname(mcpPath), { recursive: true });
          await require('node:fs/promises').writeFile(mcpPath, JSON.stringify(merged, null, 2), 'utf-8');
        } catch (e) {
          console.warn('[boos] failed to auto-write .mcp.json:', e.message);
        }
      }

      // Inject BOOS collaboration prompt (non-blocking).
      let promptExtraArgs = [];
      if (shouldLaunch) {
        try { promptExtraArgs = require('../lib/supervisorPrompt').getBasePromptCliArgs(); } catch {}
      }

      let launched = null;
      let record = null;
      if (shouldLaunch) {
        record = await persistedSessions.create({
          cliId: cli.id, cwd: launchCwd, workspace: workspace.name,
          repos: wantedRepos.map((r) => r.name),
          folderId: (req.body && req.body.folderId) || null,
          title: '',
        });

        let inheritedCliSessionId = null;
        const bestExisting = await persistedSessions.findBestByCliAndCwd(cli.id, launchCwd);
        if (bestExisting && bestExisting.id !== record.id && bestExisting.cliSessionId) {
          inheritedCliSessionId = bestExisting.cliSessionId;
          await persistedSessions.setCliSessionId(record.id, inheritedCliSessionId);
          console.log('[boos] smart resume: inherited cliSessionId from', bestExisting.id.slice(-8), '→ new session', record.id.slice(-8));
        }

        // Sprint 7: PostgreSQL resume fix — verify cliSessionId against
        // the latest known session for this cwd in PG (the mirror store).
        try {
          const pg = require('../lib/postgres');
          const pool = pg.getPool();
          if (pool && inheritedCliSessionId) {
            const { getLatestForCwd } = require('../lib/conversationSync');
            const latest = await getLatestForCwd(pool, launchCwd);
            if (latest && latest.cliSessionId !== inheritedCliSessionId) {
              await persistedSessions.setCliSessionId(record.id, latest.cliSessionId);
              inheritedCliSessionId = latest.cliSessionId;
              console.log('[boos] pg-resume: corrected cliSessionId from PG mirror →', latest.cliSessionId.slice(0, 8));
            }
          }
        } catch {}

        try {
          launched = await spawnSessionRecord({
            record, cli, cfg, body: req.body,
            resume: !!inheritedCliSessionId,
            extraCliArgs: promptExtraArgs,
          });

          // Sprint 13: update agent identity card after session launch.
          try {
            const store = require('../lib/agentBus/store');
            const allAgents = store.listAllAgents();
            const matched = allAgents.find(a => require('path').basename(launchCwd || '') === a.name);
            if (matched) {
              await store.upsertIdentity(matched.uid, {
                boos_session_id: record.id, cwd: launchCwd,
                pty_pid: launched?.pid || null, name: matched.name,
                workspace: matched.workspace, role: matched.role || 'worker',
              });
            }
          } catch (e) { /* best-effort */ }

          emit({ type: 'launched', launched });
        } catch (e) {
          await persistedSessions.markExited(record.id, null);
          return fail(`spawn failed: ${e.message}`);
        }
      }

      emit({ type: 'done', success: true, workspace, created, cloneResults, launched, session: record });
      res.end();
    } catch (e) {
      console.error('[/api/sessions/new]', e);
      fail(String(e && e.message || e));
    }
  });

  // ---- resume a previous session ----
  app.post('/api/sessions/:id/resume', resumeLimiter, asyncH(async (req, res) => {
    let record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });
    const live = webTerminal.get(record.id);
    if (live && !live.exitedAt) {
      if (record.status !== 'running' || record.pid !== live.meta.pid) {
        try { await persistedSessions.markRunning(record.id, live.meta.pid); } catch {}
      }
      return res.json({ launched: { id: record.id, pid: live.meta.pid, cliId: record.cliId } });
    }

    if (!record.cliSessionId) {
      const best = await persistedSessions.findBestByCliAndCwd(record.cliId, record.cwd);
      if (best && best.id !== record.id && best.cliSessionId) {
        await persistedSessions.setCliSessionId(record.id, best.cliSessionId);
        record = await persistedSessions.get(record.id);
        console.log('[boos] smart resume: patched cliSessionId from', best.id.slice(-8), '→', record.id.slice(-8));
      }
    }

    // Sprint 7: PostgreSQL resume fix — verify cliSessionId is the latest
    // known for this cwd. If the binding scanner hasn't caught a rotation yet,
    // PG (which mirrors every JSONL write) has the freshest session id.
    try {
      const pg = require('../lib/postgres');
      const pool = pg.getPool();
      if (pool) {
        const { getLatestForCwd } = require('../lib/conversationSync');
        const latest = await getLatestForCwd(pool, record.cwd);
        if (latest && latest.cliSessionId !== record.cliSessionId) {
          await persistedSessions.setCliSessionId(record.id, latest.cliSessionId);
          record = await persistedSessions.get(record.id);
          console.log('[boos] pg-resume: corrected stale cliSessionId →', latest.cliSessionId.slice(0, 8));
        }
      }
    } catch {}

    const cfg = await loadConfig();
    const cli = findCliById(cfg, record.cliId);
    if (!cli) return res.status(400).json({ error: `CLI ${record.cliId} no longer configured` });
    try {
      const launched = await spawnSessionRecord({ record, cli, cfg, body: req.body, resume: true });
      // Sprint 13: update agent identity card after session resume.
      try {
        const store = require('../lib/agentBus/store');
        const identity = store.getIdentityByBoosSession(record.id);
        if (identity) {
          await store.upsertIdentity(identity.agent_uid, { pty_pid: launched?.pid || null, cwd: record.cwd });
        } else {
          const allAgents = store.listAllAgents();
          const matched = allAgents.find(a => require('path').basename(record.cwd || '') === a.name);
          if (matched) {
            await store.upsertIdentity(matched.uid, {
              boos_session_id: record.id, cwd: record.cwd,
              pty_pid: launched?.pid || null, name: matched.name,
              workspace: matched.workspace, role: matched.role || 'worker',
            });
          }
        }
      } catch (e) { /* best-effort */ }
      res.json({ launched });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }));

  // ---- resume-picker ----
  app.post('/api/sessions/:id/resume-picker', asyncH(async (req, res) => {
    const record = await persistedSessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'session not found' });
    const cfg = await loadConfig();
    const cli = findCliById(cfg, record.cliId);
    if (!cli) return res.status(400).json({ error: `CLI ${record.cliId} no longer configured` });
    try {
      const launched = await spawnSessionPickerRecord({ record, cli, cfg, body: req.body });
      res.json({ launched });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }));

  // ---- list existing CLI sessions discovered on disk ----
  app.get('/api/cli-sessions', asyncH(async (req, res) => {
    const type = String(req.query.type || 'all').toLowerCase();
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 30));
    const [page, existing] = await Promise.all([
      localCliSessions.listPaginated({ type, offset, limit }),
      persistedSessions.loadAll(),
    ]);
    const recByCliSessionId = new Map();
    for (const rec of existing) {
      if (rec.cliSessionId && !recByCliSessionId.has(rec.cliSessionId)) {
        recByCliSessionId.set(rec.cliSessionId, rec);
      }
    }
    const sessions = page.sessions.map((s) => {
      const rec = recByCliSessionId.get(s.cliSessionId);
      return {
        ...s,
        adopted: !!rec,
        adoptedRecord: rec ? {
          id: rec.id, cliId: rec.cliId, title: rec.title || '',
          workspace: rec.workspace || '', folderId: rec.folderId || null,
        } : null,
      };
    });
    res.json({ sessions, total: page.total, offset: page.offset, limit: page.limit, hasMore: page.hasMore });
  }));

  // ---- import by session id ----
  app.post('/api/sessions/import-by-id', asyncH(async (req, res) => {
    const { cliSessionId } = req.body || {};
    if (!cliSessionId || typeof cliSessionId !== 'string' || !/^[0-9a-f-]+$/i.test(cliSessionId.trim())) {
      return res.status(400).json({ error: 'valid UUID required' });
    }
    const sid = cliSessionId.trim();

    const all = await persistedSessions.loadAll();
    const dup = all.find((s) => s.cliSessionId === sid);
    if (dup) return res.json({ session: dup, alreadyAdopted: true });

    const cfg = await loadConfig();
    let foundCwd = null, foundSummary = '';
    try {
      const page = await localCliSessions.listPaginated({ type: 'claude', offset: 0, limit: 500 });
      const match = page.sessions.find((s) => s.cliSessionId === sid);
      if (match) { foundCwd = match.cwd; foundSummary = match.summary || ''; }
    } catch (e) {}

    if (!foundCwd) {
      return res.status(404).json({
        error: `Session ${sid} not found in ~/.claude/projects/. Make sure Claude Code has been run in the project directory first.`,
      });
    }

    const cli = cfg.clis.find((c) => c.type === 'claude') || cfg.clis[0];
    const record = await persistedSessions.create({
      cliId: cli.id, cwd: foundCwd, workspace: path.basename(foundCwd) || foundCwd,
      folderId: null, title: foundSummary || sid.slice(0, 12),
      repos: [], status: 'exited', cliSessionId: sid,
    });

    const fsSync = require('node:fs');
    const txtPath = path.join(DATA_DIR, 'sessions.txt');
    try {
      const now = new Date().toISOString().slice(0, 10);
      const line = `${sid}  |  ${now}  |  ${foundSummary || ''}\n`;
      fsSync.appendFileSync(txtPath, line, 'utf8');
    } catch (e) {
      console.warn('[boos] could not write sessions.txt:', e.message);
    }

    res.json({ session: record, alreadyAdopted: false, cwd: foundCwd, summary: foundSummary });
  }));

  // ---- adopt: create a boos record pointing at an existing CLI session ----
  app.post('/api/sessions/adopt', asyncH(async (req, res) => {
    const { cliId, cliSessionId, cwd, title, folderId } = req.body || {};
    if (!cliId || !cliSessionId || !cwd) {
      return res.status(400).json({ error: 'cliId, cliSessionId and cwd required' });
    }
    const cfg = await loadConfig();
    const cli = findCliById(cfg, cliId);
    if (!cli) return res.status(400).json({ error: `CLI ${cliId} not configured` });

    const resolvedCwd = path.resolve(String(cwd));
    try {
      const fsmod = require('node:fs/promises');
      const st = await fsmod.stat(resolvedCwd);
      if (!st.isDirectory()) {
        return res.status(400).json({ error: `cwd is not a directory: ${resolvedCwd}` });
      }
    } catch {
      return res.status(400).json({ error: `cwd not found: ${resolvedCwd}` });
    }

    const all = await persistedSessions.loadAll();
    const dup = all.find((s) => s.cliSessionId === cliSessionId);
    if (dup) return res.json({ session: dup, alreadyAdopted: true });

    const fid = (folderId && folderId !== 'unsorted') ? folderId : null;
    const record = await persistedSessions.create({
      cliId, cwd: resolvedCwd, workspace: path.basename(resolvedCwd) || resolvedCwd,
      folderId: fid, title: title || '', repos: [], status: 'exited', cliSessionId,
    });
    res.json({ session: record, alreadyAdopted: false });
  }));
}

module.exports = { register };

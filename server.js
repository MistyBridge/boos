#!/usr/bin/env node
'use strict';
const errReport = require('./lib/errorReport');   // Sprint 42: no silent failures


const path = require('node:path');
const os = require('node:os');
const express = require('express');

const { loadConfig, saveConfig, DATA_DIR, DEFAULT_PORT, setRuntimePort } = require('./lib/config');
const { listWorkspaces, findOrCreateWorkspace, ensureReposInWorkspace, isInside } = require('./lib/workspace');
const webTerminal = require('./lib/webTerminal');
const persistedSessions = require('./lib/persistedSessions');
const localCliSessions = require('./lib/localCliSessions');
const folders = require('./lib/folders');
const tunnel = require('./lib/tunnel');
const devices = require('./lib/devices');
const pkg = require('./package.json');
const {
  asyncH,
  corsMiddleware,
  isDirectLoopback,
  createDeviceGate,
  createHostOnlyGate,
  ALLOWED_ORIGINS,
} = require('./lib/middleware');

// Extracted helpers — pure functions and factories moved to lib/.
const {
  pickCli,
  findCliById,
  resolveCommand,
  spawnEnv,
  decorateConfigWithProbes,
  stripTunnelKeys,
} = require('./lib/cliHelpers');
const {
  workspaceOccupancySessions,
  workspaceOccupancyLabel,
  launchCwdFor,
  buildResumeArgs,
  createSessionHelpers,
} = require('./lib/sessionHelpers');
const { createScanner } = require('./lib/sessionBinding');
const { openInBrowser: _openBrowserRaw } = require('./lib/browserLauncher');
const openInBrowser = (url) => _openBrowserRaw(url, DATA_DIR);

// Lifecycle extracted to lib/serverLifecycle.js (Sprint 31 — ≤500 lines).

const {
  gracefulShutdown: _gracefulShutdown,
  reclaimPortFromOldInstance,
  reconcileSessionsOnBoot,
  PORT_LOCK_PATH,
} = require('./lib/serverLifecycle');

// Wrapper that bakes in server.js dependencies so callers can use the
// simple `gracefulShutdown(reason)` signature.
const gracefulShutdown = (reason) => _gracefulShutdown(reason, {
  webTerminal, persistedSessions, DATA_DIR, tunnel,
});

const app = express();

// ── shutdown token ──────────────────────────────────────────────────────
// Generated once per server lifetime. Required by /api/shutdown and
// /api/upgrade to prevent rogue agents from killing the BOOS backend.
// Frontend reads it from /api/health; launcher (bin/boos.js) reads it
// from ~/.boos/.shutdown-token.
const SHUTDOWN_TOKEN = require('node:crypto').randomBytes(16).toString('hex');
try {
  require('node:fs').writeFileSync(
    require('node:path').join(DATA_DIR, '.shutdown-token'), SHUTDOWN_TOKEN, 'utf-8'
  );
} catch (e) { errReport.report("server", "oper", e); }

app.use(express.json({ limit: '1mb' }));

// Open CORS preflight for runtime discovery — dev tools from any origin
// can probe GET /api/runtime. Must be registered BEFORE corsMiddleware
// (which sets CORS only for MistyBridge.github.io and eats OPTIONS).
app.options('/api/runtime', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.use(corsMiddleware);

app.use(createDeviceGate());
app.use(createHostOnlyGate());

// Dev mode = running from a checkout (not from an npm-install location).
// Used to gate two things: (a) serving static frontend from local public/
// so a contributor can iterate without pushing to GH Pages; (b) hot-reload
// SSE endpoint that watches public/ for changes. BOOS_NO_DEV=1 disables
// both explicitly. In production (npm-installed), backend is API-only —
// frontend lives at https://MistyBridge.github.io/boos/ (router → per-version).
const IS_DEV = !__dirname.includes(`${path.sep}node_modules${path.sep}`) && process.env.BOOS_NO_DEV !== '1';

// Always serve public/ when it exists alongside server.js. In a
// checkout this is the live frontend used during dev. In an npm
// install this lets a tunneled session (Remote page) reach the
// frontend at the tunnel URL — the GH Pages hosted frontend is
// unreachable to a phone on cellular, but the locally-bundled
// public/ shipped in the package IS, via the tunnel. Same files
// either way; just no version router in front.
{
  const publicDir = path.join(__dirname, 'public');
  try {
    if (require('node:fs').statSync(publicDir).isDirectory()) {
      app.use(express.static(publicDir));
    }
  } catch {
    /* not bundled · API-only mode */
  }
}

// Serve node_modules for local ESM imports (preact, htm, @preact/signals).
// These packages ship .module.js ESM files that work in browsers.
  // xterm.js + addons pre-bundled into public/vendor/ via esbuild — zero external deps.
{
  const nodeModulesDir = path.join(__dirname, 'node_modules');
  try {
    if (require('node:fs').statSync(nodeModulesDir).isDirectory()) {
      app.use('/node_modules', express.static(nodeModulesDir, { maxAge: '7d' }));
    }
  } catch (e) { errReport.report("server", "oper", e); }
}

// ── Embedded Agent-Bus MCP ─────────────────────────────────────────
// Mounted directly on this Express instance — no separate process, no
// separate port. Agents connect via http://127.0.0.1:{port}/mcp/sse.
// Disable with BOOS_NO_AGENT_BUS=1.
if (process.env.BOOS_NO_AGENT_BUS !== '1') {
  try {
    const { createRouter } = require('./lib/agentBus/transport');
    app.use('/mcp', createRouter());
    console.log('[boos] agent-bus MCP mounted at /mcp/sse');
  } catch (e) {
    console.warn('[boos] agent-bus MCP failed to mount:', e.message);
  }
}

const reloadClients = new Set();
if (IS_DEV) {
  require('./routes/dev').register(app, { reloadClients, publicDir: path.join(__dirname, 'public') });
}

// ---- helper factories ----
// Moved to lib/cliHelpers.js, lib/sessionHelpers.js, lib/browserLauncher.js.
// Factories that need server.js deps are wired here.

// Create the binding scanner (extracted to lib/sessionBinding.js).
const bindingScanner = createScanner({ persistedSessions, webTerminal, loadConfig });

// Wire the scanner callbacks into the session helpers (they were null above).
const _sh = createSessionHelpers({
  webTerminal,
  persistedSessions,
  resolveCommand,
  spawnEnv,
  scheduleBindingScan: bindingScanner.scheduleBindingScan,
  scheduleBindingScanSeries: bindingScanner.scheduleBindingScanSeries,
  managedAgents: (() => {
    // Sprint 38: Auto-discover managed agents from persisted sessions.
    // Any session with a known cliSessionId (Claude --resume UUID) is a
    // managed agent — no manual config needed.  Falls back to config.json
    // for backward compatibility only if sessions.json is empty.
    try {
      const fs = require('node:fs');
      const sp = require('node:path').join(DATA_DIR, 'sessions.json');
      const sessions = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      const list = Array.isArray(sessions) ? sessions : Object.values(sessions);
      const discovered = list
        .filter(s => s.cliSessionId && !s.deletedAt)
        .map(s => s.cwd.replace(/\\/g, '/'));
      if (discovered.length > 0) {
        console.log('[boos] managedAgents auto-discovered:', discovered.length, 'paths');
        return discovered;
      }
    } catch (e) { errReport.report("server", "oper", e); }
    // Fallback: manual config (legacy).
    try {
      return JSON.parse(require('node:fs').readFileSync(
        require('node:path').join(DATA_DIR, 'config.json'), 'utf-8'
      )).managedAgents || [];
    } catch { return []; }
  })(),
});
const { spawnSessionRecord, spawnSessionPickerRecord } = _sh;

// ---- lifecycle state ----

// ---- config + CLI test ----
require('./routes/config').register(app, {
  asyncH,
  loadConfig,
  saveConfig,
  decorateConfigWithProbes,
  stripTunnelKeys,
  spawnEnv,
});

// ---- folders ----
require('./routes/folders').register(app, { asyncH, folders, persistedSessions });

// ---- sessions (persisted, boos-owned) ----
require('./routes/sessions').register(app, {
  asyncH,
  persistedSessions,
  webTerminal,
  folders,
  loadConfig,
  findCliById,
  spawnEnv,
});

// ---- workspaces + browse + layout ----
require('./routes/workspaces').register(app, {
  asyncH,
  loadConfig,
  persistedSessions,
  listWorkspaces,
  isInside,
  workspaceOccupancySessions,
  workspaceOccupancyLabel,
});

// ---- session launch / resume / import / adopt ----
require('./routes/sessions-launch').register(app, {
  asyncH,
  loadConfig,
  saveConfig,
  DATA_DIR,
  pickCli,
  findCliById,
  persistedSessions,
  webTerminal,
  localCliSessions,
  folders,
  listWorkspaces,
  findOrCreateWorkspace,
  ensureReposInWorkspace,
  isInside,
  workspaceOccupancySessions,
  workspaceOccupancyLabel,
  launchCwdFor,
  spawnSessionRecord,
  spawnSessionPickerRecord,
  getState() {
    return lifecycleState;
  },
});

// ---- lifecycle state ----
// Shared mutable state — health.js routes read/write through getState().
const lifecycleState = {
  currentPort: 0,
  frontendUrl: '',
  lastHeartbeat: Date.now(),
  heartbeatSeen: false,
  restartInFlight: false,
};
const HEARTBEAT_TIMEOUT_MS = 90_000;

// ---- idle watcher (30min idle → auto-shutdown) ----
const { createIdleWatcher } = require('./lib/idleWatcher');
const idleWatcher = createIdleWatcher({ webTerminal, lifecycleState, gracefulShutdown });
if (process.env.BOOS_KEEP_ALIVE !== '1') {
  idleWatcher.start();
}

// Bridge agent-bus MCP connections → idleWatcher activity detection.
try {
  const { setSessionCountCallback } = require('./lib/agentBus/transport');
  setSessionCountCallback((n) => idleWatcher.setMcpConnectionCount(n));
} catch (e) { errReport.report("server", "oper", e); }

// ---- health / capabilities / lifecycle ----
require('./routes/health').register(app, {
  asyncH,
  webTerminal,
  pkg,
  gracefulShutdown,
  openInBrowser,
  shutdownToken: SHUTDOWN_TOKEN,
  getState() {
    return lifecycleState;
  },
  setState(merge) {
    Object.assign(lifecycleState, merge);
  },
  idleWatcher,
});

// ---- remote / tunnel ----
require('./routes/tunnel').register(app, {
  asyncH,
  tunnel,
  saveConfig,
  getState() {
    return lifecycleState;
  },
});

// ---- devices ----
require('./routes/devices').register(app, { asyncH, devices, tunnel, isDirectLoopback });

// ---- version / upgrade ----
require('./routes/version').register(app, {
  asyncH,
  pkg,
  gracefulShutdown,
  shutdownToken: SHUTDOWN_TOKEN,
  getState() {
    return lifecycleState;
  },
});

// ---- decisions + goals ----
require('./routes/decisions').register(app, { asyncH });
require('./routes/goals').register(app, { asyncH });   // Sprint 24: AutoPilot goals
require('./routes/usage').register(app, { asyncH, persistedSessions });  // Sprint 41: token + cache telemetry
require('./routes/hr').register(app, { hrAgent: require('./lib/hrAgent') });
require('./routes/archive').register(app, { asyncH });        // Sprint 9: archive system
require('./routes/agents').register(app, { asyncH });        // Sprint 9: agent-bus ↔ canvas bridge
require('./routes/agent-bus-tasks').register(app, { asyncH });  // Sprint 17 A1: task query API
require('./routes/dags').register(app, { asyncH });             // Sprint 34: DAG REST API
require('./routes/knowledge').register(app, { asyncH });     // Sprint 10: shared knowledge base
require('./routes/workspaceConfig').register(app, { asyncH, workspaceConfig: require('./lib/workspaceConfig') }); // Sprint 32

function listenWithFallback(preferred) {
  return new Promise((resolve, reject) => {
    const attempt = (retries) => {
      const server = app.listen(preferred);
      server.once('listening', () => resolve({ server, port: preferred }));
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (retries >= 5) {
          console.error(`[boos] 启动失败: 端口 ${preferred} 被占用，5 次强行释放后仍未成功`);
          console.error(`  请手动检查占用进程: netstat -ano | findstr :${preferred}`);
          return reject(new Error(`端口 ${preferred} 被占用，无法启动`));
        }
        server.close();
        // Force-kill whatever is on the port, then retry.
        (async () => {
          try {
            const cmd = process.platform === 'win32'
              ? `netstat -ano | findstr :${preferred} | findstr LISTENING`
              : `lsof -i :${preferred} -t`;
            const output = require('node:child_process').execSync(cmd, { encoding: 'utf-8', timeout: 2000 }).trim();
            const m = output.match(/\d+$/m);
            if (m) {
              const pid = parseInt(m[0], 10);
              if (pid && pid !== process.pid) {
                console.log(`[boos] 强制终止 PID ${pid} (占用端口 ${preferred})`);
                try { process.kill(pid, 'SIGKILL'); } catch (e) { errReport.report("server", "oper", e); }
              }
            }
          } catch (e) { errReport.report("server", "oper", e); }
          await new Promise(r => setTimeout(r, 2000));
          attempt(retries + 1);
        })();
      });
    };
    attempt(0);
  });
}

// Port reclaim + session reconciliation extracted to lib/serverLifecycle.js

(async () => {
  const cfg = await loadConfig();
  const preferredPort = process.env.BOOS_PORT ? Number(process.env.BOOS_PORT) : cfg.port;
  await reclaimPortFromOldInstance(preferredPort);
  const { server, port } = await listenWithFallback(preferredPort);
  lifecycleState.currentPort = port;
  setRuntimePort(port);

  // Write runtime port lock so external tools (start.bat, Claude Code)
  // can discover the actual port + MCP URL without hardcoding.
  // Sprint 17: 总是覆盖写入 (旧实例已在启动前清理)
  try {
    const lockPayload = {
      pid: process.pid,
      port: port,
      mcpUrl: `http://127.0.0.1:${port}/mcp/sse`,
      startedAt: new Date().toISOString(),
    };
    require('node:fs').writeFileSync(PORT_LOCK_PATH, JSON.stringify(lockPayload, null, 2), 'utf-8');
    console.log(`[boos] port.lock written · pid=${process.pid} port=${port}`);
  } catch (e) {
    console.warn('[boos] failed to write port.lock:', e.message);
  }

  // On boot, reconcile persisted sessions (normalize, dedup, revive PTYs, auto-resume).
  // Extracted to lib/serverLifecycle.js (Sprint 31 refactor).
  try {
    await reconcileSessionsOnBoot({
      persistedSessions, webTerminal, loadConfig, DATA_DIR,
      spawnSessionRecord: _sh.spawnSessionRecord,
    });
  } catch (e) {
    console.error('[boos] could not reconcile persisted sessions:', e.message);
  }

  // Binding scanner — extracted to lib/sessionBinding.js via createScanner().
  // Re-runs because fork / clear / resume rotate the upstream session id.
  bindingScanner.startPeriodicScan();

  // PostgreSQL (degraded if Docker unavailable), agent-bus notifications,
  // archive system, tunnel prewarm.
  if (process.env.BOOS_NO_POSTGRES !== '1') {
    try { await require('./lib/postgres').ensureContainer(); }
    catch (e) { console.warn('[boos] postgres: ensureContainer failed —', e.message); }
  }

  if (process.env.BOOS_NO_AGENT_BUS_WATCH !== '1') {
    try {
      const { bootstrapIdentities } = require('./lib/agentBus/store');
      bootstrapIdentities().catch(e => console.warn('[boos] bootstrapIdentities failed:', e.message));

      // Sprint 35: migrate legacy tasks from shared agent-bus.json to per-agent inbox files.
      // One-time migration — subsequent starts will skip if inbox files already exist.
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('./lib/agentBus/storeCore');
      const legacyPath = path.join(DATA_DIR, 'agent-bus.json');
      const inboxDir = path.join(DATA_DIR, 'agent-bus', 'inbox');
      if (fs.existsSync(legacyPath)) {
        const inboxExists = fs.existsSync(inboxDir) && fs.readdirSync(inboxDir).length > 0;
        if (!inboxExists) {
          try {
            const db = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
            const tasks = Object.values(db.tasks || {});
            if (tasks.length > 0) {
              const { importFromLegacy } = require('./lib/agentBus/inboxStore');
              importFromLegacy(db).then(n => {
                console.log('[boos] inbox migration:', n, 'tasks moved to per-agent inboxes');
                // Clean up tasks from legacy file (keep agents/sessions/identities).
                return new Promise((resolve) => {
                  const { _load } = require('./lib/agentBus/storeCore');
                  const { withFileLock } = require('./lib/atomicJson');
                  withFileLock(legacyPath, async () => {
                    const d = await _load();
                    d.tasks = {};
                    const { _save } = require('./lib/agentBus/storeCore');
                    const tmp = path.join(path.dirname(legacyPath),
                      `.${path.basename(legacyPath)}.tmp.${process.pid}.${Date.now().toString(36)}`);
                    await fs.promises.writeFile(tmp, JSON.stringify(d, null, 2));
                    await fs.promises.rename(tmp, legacyPath);
                    resolve(true);
                  }).catch(() => resolve(false));
                }).then(ok => {
                  console.log('[boos] legacy tasks cleaned from agent-bus.json:', ok);
                });
              }).catch(e => console.warn('[boos] inbox migration failed:', e.message));
            }
          } catch (e) { console.warn('[boos] inbox migration: legacy read failed:', e.message); }
        }
      }

      // Rebuild in-memory task index on startup.
      const { rebuildTaskIndex } = require('./lib/agentBus/queue');
      rebuildTaskIndex().catch(e => console.warn('[boos] task index rebuild failed:', e.message));

      require('./lib/agentBus/notifications').start('boos').catch(e => {
        console.warn('[boos] collaboration loop init failed:', e.message);
      });
    } catch (e) { console.warn('[boos] agent-bus notifications failed to start:', e.message); }
  }

  // Auto-Supervisor: code-layer background loop for stalled-project detection.
  // Started by notifications.js after agent-bus init completes.
  // NOT started here — the log below is the last thing before listen.

  try { require('./lib/archive').startPeriodicPrune(); }
  catch (e) { console.warn('[boos] archive system failed to start:', e.message); }

  // Sprint 41: sweep externalized-content cache files older than 7 days.
  try {
    const cacheStore = require('./lib/agentBus/cacheStore');
    const swept = cacheStore.sweep();
    if (swept > 0) console.log('[boos] cache sweep:', swept, 'expired content files removed');
  } catch (e) { console.warn('[boos] cache sweep failed:', e.message); }

  // Agent-bus task lifecycle: auto-archive terminal tasks on startup,
	  // then every 6 hours. Newly terminal tasks are auto-archived immediately
	  // by updateTaskStatus → _autoArchiveTask.
	  {
	    const store = require('./lib/agentBus/store');
	    store.pruneOldTasks(0).then((n) => {
	      if (n > 0) console.log('[boos] startup auto-archive:', n, 'stale terminal tasks');
	    }).catch(() => {});
	    setInterval(() => {
	      store.pruneOldTasks(0).catch(() => {});
	    }, 6 * 3600_000).unref();
	  }

	  // Prewarm tunnel probe so Remote tab loads instantly.
  try {
    tunnel.probe(true).catch(() => {});
  } catch (e) { errReport.report("server", "oper", e); }

  // Auto-start the tunnel if the user enabled it on the Remote page.
  // This is the BACKEND PROCESS bringing its own tunnel up on startup —
  // not an OS-level autostart (no registry / scheduled task). Reuses the
  // persisted token so share URLs stay valid across restarts. Strictly
  // fire-and-forget: a failure here (devtunnel not signed in, provider
  // uninstalled, etc.) must never crash boot — it just logs and the user
  // can start manually from the Remote page.
  if (cfg.tunnel?.autoStart && cfg.tunnel?.token && cfg.tunnel?.provider) {
    tunnel.setToken(cfg.tunnel.token);
    tunnel
      .start({ provider: cfg.tunnel.provider, port: lifecycleState.currentPort })
      .then((s) => console.log(`[boos] tunnel auto-started · ${cfg.tunnel.provider} · ${s.url || 'URL pending'}`))
      .catch((e) => console.warn(`[boos] tunnel auto-start failed · ${e.message}`));
  }

  if (webTerminal.available) {
    let WebSocketServer;
    try {
      ({ WebSocketServer } = require('ws'));
    } catch (e) { errReport.report("server", "oper", e); }
    if (WebSocketServer) {
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', async (req, socket, head) => {
        const direct = isDirectLoopback(req);
        // Non-loopback WS: device id alone gates entry. The host
        // explicitly Approved this device id earlier — that approval
        // IS the credential. No token check here (matches the device
        // gate above: token is only for /api/devices/me registration).
        if (!direct) {
          try {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const devId = u.searchParams.get('device');
            if (!devId) {
              socket.destroy();
              return;
            }
            const d = await devices.get(devId);
            if (!d || d.status !== 'approved') {
              socket.destroy();
              return;
            }
          } catch {
            socket.destroy();
            return;
          }
        } else {
          const origin = req.headers.origin;
          if (origin && !ALLOWED_ORIGINS.has(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
            socket.destroy();
            return;
          }
        }
        const m = req.url && req.url.match(/^\/ws\/terminal\/([^\/?#]+)/);
        if (!m) {
          socket.destroy();
          return;
        }
        const id = decodeURIComponent(m[1]);
        wss.handleUpgrade(req, socket, head, (ws) => webTerminal.attach(id, ws));
      });
      console.log('[boos] web terminal bridge active (WebSocket /ws/terminal/:id)');
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => gracefulShutdown(sig));
  }
  process.on('exit', () => {
    try {
      webTerminal.killAll();
    } catch (e) { errReport.report("server", "oper", e); }
  });

  const apiUrl = `http://localhost:${port}`;
  const FRONTEND_URL = IS_DEV ? apiUrl : 'https://MistyBridge.github.io/boos/';
  lifecycleState.frontendUrl = FRONTEND_URL;
  // Crash resilience — log and attempt graceful shutdown so the next boot
  // can auto-resume managed sessions.  Without cleanup the port.lock stays
  // and active-sessions.json is never written, breaking crash-reconnect.
  process.on('unhandledRejection', (reason) => {
    console.error('[boos] UNHANDLED REJECTION:', reason?.message || reason);
    if (reason?.stack) console.error(reason.stack);
  });
  process.on('uncaughtException', (err) => {
    console.error('[boos] UNCAUGHT EXCEPTION:', err.message);
    if (err.stack) console.error(err.stack);
    // Attempt graceful shutdown — at minimum this writes active-sessions.json
    // and removes port.lock so the next boot can cleanly take over the port
    // and auto-resume managed agent sessions.
    try { gracefulShutdown('uncaught exception: ' + (err.message || 'unknown')); } catch (e) { errReport.report("server", "oper", e); }
    // If gracefulShutdown didn't exit (e.g. it hung), force exit after 5s.
    setTimeout(() => process.exit(1), 5000).unref();
  });

  console.log(
    `boos listening on ${apiUrl}`,
  );
  console.log(`frontend at      ${FRONTEND_URL}`);
  console.log(`data dir:        ${DATA_DIR}`);
  console.log(`work dir:        ${cfg.workDir}`);
  console.log(`clis:            ${cfg.clis.map((c) => c.id).join(', ')} (default: ${cfg.defaultCliId})`);

  // BOOS_NO_BROWSER / BOOS_FROM_UPGRADE suppress auto-open browser window.
  const suppressBrowser = process.env.BOOS_NO_BROWSER === '1' || process.env.BOOS_FROM_UPGRADE === '1';
  const opened = suppressBrowser ? { kind: 'none', child: null } : openInBrowser(FRONTEND_URL);

  // Lifecycle: browser close no longer kills the server.
  // The server stays alive as long as there are active sessions or
  // recent frontend heartbeats. Idle shutdown is handled by the
  // unified heartbeat/idle watchdog below.
  // BOOS_KEEP_ALIVE=1 disables all automatic shutdown.

  if (process.env.BOOS_KEEP_ALIVE !== '1') {
    // Heartbeat watchdog: 2 paths — (1) lost heartbeat after seen → 90s, (2) never seen → 120s.
    // Sprint 38 crash fix: both paths now also check for MCP connections and managed agent
    // sessions (even if PTY is dead — auto-resume will handle them).  Prevents the server
    // from self-terminating while agents are still working or waiting for frontend reconnect.
    setInterval(() => {
      const uptime = process.uptime() * 1000;
      const hasLiveSession = webTerminal.list().some((t) => !t.exitedAt);
      // Check for managed agent sessions with cliSessionId (Claude UUIDs).
      // These sessions may have dead PTYs but the agent is still a managed
      // worker — auto-resume will bring them back on frontend reconnect.
      let hasManagedAgents = false;
      try {
        const allSessions = persistedSessions._store?.data || {};
        hasManagedAgents = Object.values(allSessions).some(
          (s) => s.cliSessionId && !s.deletedAt && !s.manualStopped
        );
      } catch (e) { errReport.report("server", "oper", e); }
      // MCP connections keep the server alive in all modes.
      let mcpCount = 0;
      try { mcpCount = idleWatcher.status().mcpConnections || 0; } catch (e) { errReport.report("server", "oper", e); }
      const hasMcp = mcpCount > 0;
      // Managed agent sessions with pending inbox tasks mean work is in flight.
      let agentsWithWork = 0;
      try {
        const inboxDir = require('node:path').join(DATA_DIR, 'agent-bus', 'inbox');
        const fs = require('node:fs');
        const errReport = require("./lib/errorReport");
        if (fs.existsSync(inboxDir)) {
          const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json') && !f.endsWith('.bak'));
          for (const f of files) {
            try {
              const data = JSON.parse(fs.readFileSync(require('node:path').join(inboxDir, f), 'utf-8'));
              if ((data.pending || []).length + (data.in_progress || []).length > 0) agentsWithWork++;
            } catch (e) { errReport.report("server", "oper", e); }
          }
        }
      } catch (e) { errReport.report("server", "oper", e); }

      if (lifecycleState.heartbeatSeen) {
        if (Date.now() - lifecycleState.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          if (!hasLiveSession && !hasMcp && !hasManagedAgents && agentsWithWork === 0) {
            gracefulShutdown(`no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
          }
        }
        return;
      }
      // Never-seen heartbeat: wait for frontend OR MCP OR managed agents.
      // The server stays alive as long as there are managed agents with work,
      // MCP connections, or live sessions — even if no browser has connected yet.
      if (!hasLiveSession && uptime > 120_000 && !hasMcp && !hasManagedAgents) {
        gracefulShutdown('no frontend connected within 120s of boot');
      }
    }, 30_000);
    console.log('[boos] heartbeat watchdog active (respects live sessions + MCP + managed agents)');
  }
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});

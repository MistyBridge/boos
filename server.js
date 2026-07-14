#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const express = require('express');

const { loadConfig, saveConfig, DATA_DIR } = require('./lib/config');
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

// One unified exit path: kill PTY children, then exit. v1.0 dropped the
// snapshot-on-exit behaviour because the new persistedSessions store is
// the source of truth (and is always on disk, not in memory).
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boos] shutting down · ${reason}`);
  // 1. Send Ctrl+C to every PTY and wait for natural exit (up to 15s) so CLI
  //    processes can flush session state to disk. Order matters: kill FIRST,
  //    then mark exited — reversing this causes the CLI's onExit callback to
  //    run after we already wrote status:'exited', which is harmless, but the
  //    real goal is giving the CLI time to save state before this function
  //    calls process.exit.
  try {
    await webTerminal.gracefulKillAll(15000);
  } catch {}
  // 2. Mark all running sessions as exited so the next launch doesn't show
  //    stale "running" rows.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') {
        await persistedSessions.markExited(s.id, null).catch(() => {});
      }
    }
  } catch {}
  try {
    tunnel.stop();
  } catch {}
  process.exit(0);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

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
} catch {}

// ---- health / capabilities / lifecycle ----
require('./routes/health').register(app, {
  asyncH,
  webTerminal,
  pkg,
  gracefulShutdown,
  openInBrowser,
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
  getState() {
    return lifecycleState;
  },
});

// ---- decisions ----
require('./routes/decisions').register(app, { asyncH });
require('./routes/hr').register(app, { hrAgent: require('./lib/hrAgent') });

function listenWithFallback(preferred) {
  return new Promise((resolve, reject) => {
    const attempt = (port, tries) => {
      const server = app.listen(port);
      server.once('listening', () => resolve({ server, port: server.address().port }));
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (tries < 9) attempt(port + 1, tries + 1);
        else if (tries === 9) attempt(0, tries + 1);
        else reject(err);
      });
    };
    attempt(preferred, 0);
  });
}

(async () => {
  const cfg = await loadConfig();
  const preferredPort = process.env.BOOS_PORT ? Number(process.env.BOOS_PORT) : cfg.port;
  const { server, port } = await listenWithFallback(preferredPort);
  lifecycleState.currentPort = port;

  // On boot, normalize legacy records and mark any persisted "running"
  // sessions as exited — they belong to a previous server process whose
  // PTYs are gone.
  try {
    await persistedSessions.normalizeStore();
    let all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') {
        await persistedSessions.markExited(s.id, null);
      }
    }

    // Reload after markExited so dedup sees updated statuses.
    all = await persistedSessions.loadAll();

    // Dedup: for duplicate (cliId, cwd) pairs, soft-delete entries that
    // lack cliSessionId when a sibling session for the same (cliId, cwd)
    // DOES have one. This cleans up "ghost" sessions that would otherwise
    // start fresh conversations on resume, losing the agent's history.
    const seen = new Map(); // key = cliId|resolvedCwd → { best, ghosts }
    for (const s of all) {
      if (s.status === 'running') continue; // don't touch live sessions
      if (s.deletedAt) continue; // already soft-deleted
      const key = `${s.cliId}|${(s.cwd || '').toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, { best: null, ghosts: [] });
      const entry = seen.get(key);
      if (s.cliSessionId) {
        if (entry.best && entry.best.cliSessionId) {
          if ((entry.best.lastActiveAt || 0) >= (s.lastActiveAt || 0)) {
            entry.ghosts.push(s);
          } else {
            entry.ghosts.push(entry.best);
            entry.best = s;
          }
        } else {
          entry.best = s;
        }
      } else {
        entry.ghosts.push(s);
      }
    }
    let deduped = 0;
    for (const [, entry] of seen) {
      if (!entry.best || !entry.best.cliSessionId) continue;
      for (const ghost of entry.ghosts) {
        if (!ghost.cliSessionId && ghost.status !== 'running') {
          await persistedSessions.remove(ghost.id);
          deduped++;
        }
      }
    }
    if (deduped > 0) {
      console.log(`[boos] dedup: soft-deleted ${deduped} ghost session(s) (no cliSessionId, sibling had one)`);
    }
  } catch (e) {
    console.error('[boos] could not reconcile persisted sessions:', e.message);
  }

  // Binding scanner — extracted to lib/sessionBinding.js via createScanner().
  // Re-runs because fork / clear / resume rotate the upstream session id.
  bindingScanner.startPeriodicScan();

  // ── Agent-Bus notifications ────────────────────────────────────────
  // In-process push bridge: listens to queue.inboxEvents and writes
  // wake-up messages to agent PTYs. Replaces the SSE-based
  // agentBusWatcher — no external connection needed since agent-bus
  // is now embedded. Disable with BOOS_NO_AGENT_BUS_WATCH=1.
  if (process.env.BOOS_NO_AGENT_BUS_WATCH !== '1') {
    try {
      require('./lib/agentBus/notifications').start('boos').catch(e => {
        console.warn('[boos] collaboration loop init failed:', e.message);
      });
    } catch (e) {
      console.warn('[boos] agent-bus notifications failed to start:', e.message);
    }
  }

  // Prewarm tunnel provider probe. First /api/tunnel/status round-trip
  // shells out to where.exe / --version / devtunnel user show — ~700ms
  // of synchronous work that the user otherwise waits on the moment
  // they open the Remote tab. Fire in the background here so the cache
  // is warm by the time anyone clicks.
  try {
    tunnel.probe(true).catch(() => {});
  } catch {}

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
    } catch {}
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
    } catch {}
  });

  const apiUrl = `http://localhost:${port}`;
  const FRONTEND_URL = IS_DEV ? apiUrl : 'https://MistyBridge.github.io/boos/';
  lifecycleState.frontendUrl = FRONTEND_URL;
  console.log(
    `boos listening on ${apiUrl}${port !== preferredPort ? `  (requested ${preferredPort}, was taken)` : ''}`,
  );
  console.log(`frontend at      ${FRONTEND_URL}`);
  console.log(`data dir:        ${DATA_DIR}`);
  console.log(`work dir:        ${cfg.workDir}`);
  console.log(`clis:            ${cfg.clis.map((c) => c.id).join(', ')} (default: ${cfg.defaultCliId})`);

  // BOOS_NO_BROWSER=1 (set by the boos:// protocol launcher) suppresses
  // the auto-open entirely. BOOS_FROM_UPGRADE=1 (set by upgrade-helper
  // when it respawns boos post-install) does the same: the user is
  // already in the helper UI which redirects to this fresh backend, so
  // a second app-mode window would just shadow the first. Otherwise try
  // app-mode (chromeless Edge/Chrome window); if no such browser is
  // installed, openInBrowser falls back to the OS default browser on
  // its own.
  const suppressBrowser = process.env.BOOS_NO_BROWSER === '1' || process.env.BOOS_FROM_UPGRADE === '1';
  const opened = suppressBrowser ? { kind: 'none', child: null } : openInBrowser(FRONTEND_URL);

  // Lifecycle: browser close no longer kills the server.
  // The server stays alive as long as there are active sessions or
  // recent frontend heartbeats. Idle shutdown is handled by the
  // unified heartbeat/idle watchdog below.
  // BOOS_KEEP_ALIVE=1 disables all automatic shutdown.

  if (process.env.BOOS_KEEP_ALIVE !== '1') {
    // Heartbeat watchdog — prevents zombie processes when the frontend
    // disconnects. Runs every 30s regardless of whether a heartbeat was
    // ever seen. Two shutdown paths:
    //
    //   1. Heartbeat seen, then lost → 90s grace period (users refresh page, etc.)
    //   2. No heartbeat ever seen within 120s of boot → the browser opened but
    //      the frontend failed to connect (wrong version, network issue). Kill
    //      the server rather than running forever as a zombie.
    setInterval(() => {
      const uptime = process.uptime() * 1000;
      const hasLiveSession = webTerminal.list().some((t) => !t.exitedAt);

      // Path 1: frontend was seen once but stopped sending heartbeats.
      if (lifecycleState.heartbeatSeen) {
        if (Date.now() - lifecycleState.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          if (!hasLiveSession) {
            gracefulShutdown(`no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
          }
        }
        return;
      }

      // Path 2: no frontend ever connected. If there are no PTY sessions
      // either, the server is a zombie — shut it down after 120s.
      if (!hasLiveSession && uptime > 120_000) {
        gracefulShutdown('no frontend connected within 120s of boot');
      }
    }, 30_000);
    console.log('[boos] heartbeat watchdog active (respects live sessions)');
  }
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

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

// One unified exit path: kill PTY children, then exit. v1.0 dropped the
// snapshot-on-exit behaviour because the new persistedSessions store is
// the source of truth (and is always on disk, not in memory).

// ── Runtime port lock ────────────────────────────────────────────────
// Written on startup so external tools (start.bat, Claude Code, CI
// scripts) can discover the actual bound port + MCP URL. Deleted on
// graceful shutdown.
const PORT_LOCK_PATH = path.join(DATA_DIR, 'port.lock');

function isPidDead(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
}

let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boos] shutting down · ${reason}`);

  // Delete port.lock so external tools know this instance is gone.
  try { require('node:fs').unlinkSync(PORT_LOCK_PATH); } catch {}

  // 1. Send Ctrl+C to every PTY and wait for natural exit (up to 15s) so CLI
  //    processes can flush session state to disk. Order matters: kill FIRST,
  //    then mark exited — reversing this causes the CLI's onExit callback to
  //    run after we already wrote status:'exited', which is harmless, but the
  //    real goal is giving the CLI time to save state before this function
  //    calls process.exit.
  try {
    await webTerminal.gracefulKillAll(15000);
  } catch {}
  // 2. Save active session list for auto-resume on next boot (Sprint 17 C1).
  try {
    const all = await persistedSessions.loadAll();
    const activeIds = all.filter((s) => s.status === 'running').map((s) => s.id);
    const fs = require('node:fs');
    const path = require('node:path');
    const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
    if (activeIds.length > 0) {
      fs.writeFileSync(AUTO_RESUME_PATH, JSON.stringify({ ids: activeIds, savedAt: new Date().toISOString() }));
      console.log(`[boos] saved ${activeIds.length} active session(s) for auto-resume`);
    }
  } catch {}

  // 3. Mark all running sessions as exited so the next launch doesn't show
  //    stale "running" rows.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') {
        await persistedSessions.markExited(s.id, null).catch(() => {});
      }
    }
  } catch {}
  // 3. Stop PostgreSQL container (Sprint 7).
  try {
    await require('./lib/postgres').stopContainer();
  } catch {}
  // 4. Stop archive periodic prune (Sprint 9).
  try {
    require('./lib/archive').stopPeriodicPrune();
  } catch {}
  try {
    tunnel.stop();
  } catch {}
  process.exit(0);
}

const app = express();
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
require('./routes/archive').register(app, { asyncH });        // Sprint 9: archive system
require('./routes/agents').register(app, { asyncH });        // Sprint 9: agent-bus ↔ canvas bridge
require('./routes/agent-bus-tasks').register(app, { asyncH });  // Sprint 17 A1: task query API
require('./routes/knowledge').register(app, { asyncH });     // Sprint 10: shared knowledge base

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

// ---- 启动前清理旧实例 (Sprint 17: 彻底解决端口冲突) ----
async function reclaimPortFromOldInstance(preferredPort) {
  const fs = require('node:fs');
  const http = require('node:http');
  let oldPort = null;
  let oldPid = null;

  try {
    const existingRaw = fs.readFileSync(PORT_LOCK_PATH, 'utf-8');
    const existing = JSON.parse(existingRaw);
    if (existing.pid && existing.port && !isPidDead(existing.pid)) {
      oldPort = existing.port;
      oldPid = existing.pid;
    }
  } catch { /* port.lock 不存在或解析失败 */ }

  // 即使 port.lock 不存在，也要检查端口是否被占用
  // (旧实例可能已删除 port.lock 但仍在退出中)
  if (!oldPort) {
    const portInUse = await new Promise((resolve) => {
      const test = http.createServer();
      test.once('error', () => resolve(true));
      test.once('listening', () => { test.close(); resolve(false); });
      test.listen(preferredPort, '127.0.0.1');
    });
    if (portInUse) {
      oldPort = preferredPort;
      console.log(`[boos] 端口 ${preferredPort} 已被占用 — 尝试探测占用进程...`);
      // 尝试通过端口查找占用进程的 PID (Windows: netstat, Unix: lsof)
      try {
        const { execSync } = require('node:child_process');
        const cmd = process.platform === 'win32'
          ? `netstat -ano | findstr :${preferredPort} | findstr LISTENING`
          : `lsof -i :${preferredPort} -t`;
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 2000 }).trim();
        // Windows: "TCP    0.0.0.0:7780    0.0.0.0:0    LISTENING    12345"
        // Unix: "12345"
        const match = output.match(/\d+$/);
        if (match) {
          const detectedPid = parseInt(match[0], 10);
          // 验证进程是否为 BOOS (避免误杀其他程序)
          const isBoos = await _isBoosProcess(detectedPid);
          if (isBoos) {
            oldPid = detectedPid;
            console.log(`[boos] 检测到端口 ${preferredPort} 被 BOOS 进程 PID ${oldPid} 占用`);
          } else {
            console.warn(`[boos] 端口 ${preferredPort} 被非 BOOS 进程 PID ${detectedPid} 占用 — 跳过清理`);
            oldPort = null; // 放弃清理，让 listenWithFallback 使用备用端口
          }
        }
      } catch (e) {
        console.warn('[boos] 端口探测失败:', e.message);
      }
    }
  }

  if (oldPid && !isPidDead(oldPid)) {
    console.log(`[boos] 检测到旧实例 PID ${oldPid} (port ${oldPort}) — 发送关闭信号...`);

    // 1. 发送优雅关闭信号
    try {
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: oldPort,
          path: '/api/shutdown', method: 'POST', timeout: 3000,
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });
    } catch {}

    // 2. 等待旧实例释放端口 (最多 20s — gracefulShutdown 等 PTY 退出最多 15s)
    console.log(`[boos] 等待旧实例退出 (最多 20s)...`);
    for (let i = 0; i < 40; i++) { // 40 * 500ms = 20s
      await new Promise(r => setTimeout(r, 500));
      // 检查 PID 是否还存活 (比端口探测更可靠)
      if (isPidDead(oldPid)) {
        console.log(`[boos] 旧实例 PID ${oldPid} 已退出`);
        oldPort = null; // 标记已成功清理
        break;
      }
    }
  }

  // 3. Fallback: 如果旧实例仍存活，强制 kill
  if (oldPid && !isPidDead(oldPid)) {
    console.warn(`[boos] 旧实例 PID ${oldPid} 未响应关闭信号 — 强制终止...`);
    try { process.kill(oldPid, 'SIGKILL'); } catch {}
    // 再等 3s 让 OS 释放端口
    await new Promise(r => setTimeout(r, 3000));
  }

  // 4. 清理 port.lock
  try { fs.unlinkSync(PORT_LOCK_PATH); } catch {}
}

// 检查进程是否为 BOOS (通过命令行判断)
async function _isBoosProcess(pid) {
  try {
    const { execSync } = require('node:child_process');
    const cmd = process.platform === 'win32'
      ? `wmic process where "processid=${pid}" get commandline /format:list`
      : `ps -p ${pid} -o args=`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 2000 });
    // 检查命令行是否包含 server.js 或 boos
    return /server\.js|boos/i.test(output);
  } catch {
    return false;
  }
}

(async () => {
  const cfg = await loadConfig();
  const preferredPort = process.env.BOOS_PORT ? Number(process.env.BOOS_PORT) : cfg.port;
  // Sprint 17: 启动前先清理旧实例，确保端口可用
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

    // Sprint 9: auto-resume sessions whose PTYs survived the restart.
    // Claude CLI processes are separate OS processes — they outlive the
    // BOOS server restart. Find sessions whose persisted status was just
    // marked 'exited' but have a live PTY, and restore 'running' status.
    let revived = 0;
    try {
      const liveTermIds = new Set(
        webTerminal.list().filter((t) => !t.exitedAt).map((t) => t.id),
      );
      for (const s of all) {
        if (s.status === 'exited' && liveTermIds.has(s.id)) {
          try {
            const term = webTerminal.get(s.id);
            await persistedSessions.markRunning(s.id, term ? term.pid : null);
            revived++;
          } catch {}
        }
      }
    } catch {}
    if (revived > 0) {
      console.log(`[boos] auto-resume: ${revived} session(s) with surviving PTYs restored to running`);
    }

    // Sprint 17 C1: auto-resume sessions that were active at last shutdown.
    // Reads the active-sessions.json saved by gracefulShutdown and spawns
    // new PTYs with --resume <id> so agents come back online automatically.
    try {
      const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
      const raw = require('fs').readFileSync(AUTO_RESUME_PATH, 'utf-8');
      const { ids } = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) {
        console.log(`[boos] auto-resume: restoring ${ids.length} session(s) from previous run...`);
        const cfg = await loadConfig();
        const cliHelpers = require('./lib/cliHelpers');
        let resumed = 0;
        for (const id of ids) {
          try {
            const record = await persistedSessions.get(id);
            if (!record) continue;
            // Skip if already running (surviving PTY handled above).
            const live = webTerminal.get(record.id);
            if (live && !live.exitedAt) continue;
            // Skip if manually stopped.
            if (record.manualStopped) continue;

            const cli = cliHelpers.findCliById(cfg, record.cliId);
            if (!cli) continue;

            await _sh.spawnSessionRecord({ record, cli, cfg, body: {}, resume: true });
            resumed++;
            console.log(`[boos] auto-resume: restored session ${id.slice(-8)} (${record.title || record.cwd})`);
          } catch (e) {
            console.warn(`[boos] auto-resume: failed to resume ${id.slice(-8)}:`, e.message);
          }
        }
        if (resumed > 0) {
          console.log(`[boos] auto-resume: restored ${resumed}/${ids.length} session(s)`);
        }
      }
      // Clean up the auto-resume file so it doesn't re-run on next boot.
      try { require('fs').unlinkSync(AUTO_RESUME_PATH); } catch {}
    } catch (e) {
      // File doesn't exist (first boot) or parse error — both non-fatal.
      if (e.code !== 'ENOENT') {
        console.warn('[boos] auto-resume: could not restore sessions:', e.message);
      }
    }
  } catch (e) {
    console.error('[boos] could not reconcile persisted sessions:', e.message);
  }

  // Binding scanner — extracted to lib/sessionBinding.js via createScanner().
  // Re-runs because fork / clear / resume rotate the upstream session id.
  bindingScanner.startPeriodicScan();

  // Sprint 7: PostgreSQL conversation persistence — ensure Docker container
  // is running and healthy, create tables. Degrades gracefully if Docker is
  // not available (server boots normally, just without PG sync).
  if (process.env.BOOS_NO_POSTGRES !== '1') {
    try {
      await require('./lib/postgres').ensureContainer();
    } catch (e) {
      console.warn('[boos] postgres: ensureContainer failed —', e.message);
    }
  }

  // ── Agent-Bus notifications ────────────────────────────────────────
  // In-process push bridge: listens to queue.inboxEvents and writes
  // wake-up messages to agent PTYs. Replaces the SSE-based
  // agentBusWatcher — no external connection needed since agent-bus
  // is now embedded. Disable with BOOS_NO_AGENT_BUS_WATCH=1.
  if (process.env.BOOS_NO_AGENT_BUS_WATCH !== '1') {
    try {
      // Sprint 14: rebuild identity cards from persisted agents/sessions
      // so sandbox folder-level PM/SE works immediately after restart.
      const { bootstrapIdentities, pruneOldTasks } = require('./lib/agentBus/store');
      bootstrapIdentities().catch(e => console.warn('[boos] bootstrapIdentities failed:', e.message));

      // Sprint 18: prune old tasks to prevent store file bloat.
      // 4063 accumulated tasks = 3 MB JSON → every withFileLock write
      // parses + serialises the whole file.  Trim completed/cancelled
      // tasks older than 7 days on startup, then every 6 hours.
      pruneOldTasks().catch(e => console.warn('[boos] pruneOldTasks failed:', e.message));
      setInterval(() => {
        pruneOldTasks().catch(e => console.warn('[boos] pruneOldTasks failed:', e.message));
      }, 6 * 3600_000).unref();

      require('./lib/agentBus/notifications').start('boos').catch(e => {
        console.warn('[boos] collaboration loop init failed:', e.message);
      });
    } catch (e) {
      console.warn('[boos] agent-bus notifications failed to start:', e.message);
    }
  }

  // Sprint 9: archive system — periodic prune of expired items.
  try {
    require('./lib/archive').startPeriodicPrune();
  } catch (e) {
    console.warn('[boos] archive system failed to start:', e.message);
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
    // ever seen. Two shutdown paths (paths 1-2 below):
    //
    //   1. Heartbeat seen, then lost → 90s grace period.
    //   2. No heartbeat ever seen within 120s of boot → zombie kill.
    //
    // Sprint 17: BOOS_NO_BROWSER=1 means we intentionally did not open a
    // browser window (e.g. boos:// protocol handler, headless mode). Don't
    // apply Path 2 in this mode — the server is meant to run headless.
    setInterval(() => {
      const uptime = process.uptime() * 1000;
      const hasLiveSession = webTerminal.list().some((t) => !t.exitedAt);

      // Path 1: frontend was seen once but stopped sending heartbeats.
      if (lifecycleState.heartbeatSeen) {
        if (Date.now() - lifecycleState.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          // Sprint 17: In headless mode (BOOS_NO_BROWSER=1), MCP
          // connections keep the server alive even when the frontend
          // stops sending heartbeats. This prevents the server from
          // dying when a PWA tab connects briefly in headless mode
          // and then closes — the MCP SSE clients still need it.
          const isHeadlessP1 = process.env.BOOS_NO_BROWSER === '1';
          const hasMcp = isHeadlessP1 && idleWatcher.status().mcpConnections > 0;
          if (!hasLiveSession && !hasMcp) {
            gracefulShutdown(`no heartbeat for ${HEARTBEAT_TIMEOUT_MS / 1000}s`);
          }
        }
        return;
      }

      // Path 2: no frontend ever connected. Skip if headless mode
      // (BOOS_NO_BROWSER) — no frontend is expected.
      const isHeadless = process.env.BOOS_NO_BROWSER === '1';
      if (!hasLiveSession && uptime > 120_000 && !isHeadless) {
        gracefulShutdown('no frontend connected within 120s of boot');
      }
    }, 30_000);
    console.log('[boos] heartbeat watchdog active (respects live sessions)');
  }
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});

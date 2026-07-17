// Health + capabilities + lifecycle routes.
// Replaces inline handlers in server.js L1424–1663.
//
// register(app, deps)
//   deps: { asyncH, webTerminal, pkg, gracefulShutdown, openInBrowser,
//           getState, setState }
//
// Mutable state (currentPort, frontendUrl, lastHeartbeat, heartbeatSeen,
// restartInFlight) is owned by server.js and accessed through getState() /
// setState(merge).

'use strict';

const path = require('node:path');
const os = require('node:os');

function register(app, { asyncH, webTerminal, pkg, gracefulShutdown, openInBrowser, getState, setState, idleWatcher }) {

  // ---- capabilities ----
  app.get('/api/capabilities', (_req, res) => res.json({
    webTerminal: webTerminal.available,
    webTerminalError: webTerminal.available ? null : String(webTerminal.loadError?.message || 'unavailable'),
  }));

  // ---- health ----
  app.get('/api/health', (_req, res) => res.json({
    ok: true, pid: process.pid, version: pkg.version, name: pkg.name,
  }));

  // ---- runtime discovery ----
  // Public CORS — local dev tools (Claude Code, CI scripts) probe this to
  // discover the actual port and MCP URL without hardcoding them.
  app.get('/api/runtime', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const s = getState();
    res.json({
      pid: process.pid,
      port: s.currentPort,
      version: pkg.version,
      mcpUrl: `http://127.0.0.1:${s.currentPort}/mcp/sse`,
    });
  });

  // ---- heartbeat ----
  app.post('/api/heartbeat', (_req, res) => {
    const s = getState();
    s.lastHeartbeat = Date.now();
    if (!s.heartbeatSeen) {
      s.heartbeatSeen = true;
      console.log('[boos] first heartbeat received — frontend is alive');
    }
    res.json({ ok: true });
  });

  // ---- spawn-browser ----
  app.post('/api/spawn-browser', asyncH(async (_req, res) => {
    const { currentPort, frontendUrl } = getState();
    const opened = await openInBrowser(frontendUrl || `http://localhost:${currentPort}`);
    res.json({ ok: true, mode: opened.kind, url: frontendUrl });
  }));

  // ---- shutdown ----
  app.post('/api/shutdown', (_req, res) => {
    res.json({ ok: true, bye: 'shutting down' });
    setImmediate(() => gracefulShutdown('/api/shutdown'));
  });

  // ---- keep-alive status ----
  app.get('/api/keep-alive/status', (_req, res) => {
    res.json(idleWatcher ? idleWatcher.status() : {
      keepAlive: process.env.BOOS_KEEP_ALIVE === '1',
      activeSessions: 0,
      lastHeartbeatMs: 0,
      mcpConnections: 0,
      idleTimeMs: 0,
      willShutdownAfterMs: 0,
      idleTimeoutMs: 0,
      heartbeatWindowMs: 0,
      note: 'idleWatcher not active',
    });
  });

  // ---- restart ----
  app.post('/api/restart', asyncH(async (_req, res) => {
    const s = getState();
    if (s.restartInFlight) {
      return res.status(409).json({ error: 'restart already in progress' });
    }
    s.restartInFlight = true;

    if (process.env.BOOS_DEV === '1') {
      res.json({ ok: true, started: true, mode: 'dev', closeFrontend: false });
      setImmediate(() => gracefulShutdown('restart (dev)'));
      return;
    }

    const fsp = require('node:fs/promises');
    const helperSrc = path.join(__dirname, '..', 'scripts', 'restart-helper.js');
    const helperTmp = path.join(os.tmpdir(), `boos-restart-${process.pid}-${Date.now()}.js`);
    try {
      await fsp.copyFile(helperSrc, helperTmp);
    } catch (e) {
      s.restartInFlight = false;
      return res.status(500).json({ error: `helper copy failed: ${e.message}` });
    }
    const args = [helperTmp, String(s.currentPort), String(process.pid)];
    res.json({ ok: true, started: true, helper: helperTmp, closeFrontend: true });

    setImmediate(() => {
      const { spawn } = require('node:child_process');
      try {
        const child = spawn(process.execPath, args, {
          detached: true, stdio: 'ignore', windowsHide: true, shell: false,
        });
        child.unref();
        console.log(`[restart] helper pid=${child.pid}, shutting down`);
      } catch (e) {
        console.error(`[restart] failed to spawn helper: ${e.message}`);
        s.restartInFlight = false;
        return;
      }
      setTimeout(() => gracefulShutdown('restart'), 500);
    });
  }));
}

module.exports = { register };

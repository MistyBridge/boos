'use strict';

// E2E test helpers — spawn/kill BOOS server for integration tests.
//
// Usage:
//   const { spawnServer, killServer } = require('./helpers');
//   const server = await spawnServer();
//   const res = await fetch(`${server.baseUrl}/api/health`);
//   await killServer(server);

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BOOS_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Find a free port on localhost.
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Wait for a URL to return HTTP 200, retrying up to `timeoutMs`.
 * @param {string} url
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>}
 */
async function waitForHealth(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Spawn a BOOS server with a random free port.
 *
 * Sets BOOS_HOME to a temp directory so tests don't touch real config.
 * Sets BOOS_NO_BROWSER=1 to skip opening a browser window.
 * Sets BOOS_NO_AGENT_BUS_WATCH=1 to skip agent-bus push notifications.
 *
 * @param {object} [opts]
 * @param {string} [opts.boosHome] — custom BOOS_HOME dir
 * @returns {Promise<{baseUrl:string, port:number, process:ChildProcess, boosHome:string}>}
 */
async function spawnServer(opts = {}) {
  const port = await findFreePort();
  const boosHome = opts.boosHome || path.join(require('os').tmpdir(), `boos-e2e-${Date.now().toString(36)}`);

  require('node:fs').mkdirSync(boosHome, { recursive: true });

  // Write a minimal config.json so BOOS uses our chosen port.
  // BOOS reads port from config.json in BOOS_HOME, and has its own
  // port-fallback logic (+1..+9). By pre-writing the config we ensure
  // the server starts on the exact port we expect.
  require('node:fs').writeFileSync(
    path.join(boosHome, 'config.json'),
    JSON.stringify({ port }, null, 2),
    'utf8'
  );

  const env = {
    ...process.env,
    BOOS_HOME: boosHome,
    BOOS_NO_BROWSER: '1',
    BOOS_NO_AGENT_BUS_WATCH: '1',
    BOOS_NO_AGENT_BUS: '1', // Disable embedded agent-bus for E2E; we test REST API only
  };

  const serverProc = spawn('node', ['server.js'], {
    cwd: BOOS_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Collect stdout/stderr for debugging
  let stdout = '';
  let stderr = '';
  serverProc.stdout.on('data', (d) => { stdout += d.toString(); });
  serverProc.stderr.on('data', (d) => { stderr += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;

  // Wait for server to be healthy
  const healthy = await waitForHealth(`${baseUrl}/api/health`, 15000);
  if (!healthy) {
    // Server failed to start — kill and report
    try { serverProc.kill('SIGTERM'); } catch {}
    const err = new Error(`BOOS server failed to start within 15s\nstdout: ${stdout.slice(-500)}\nstderr: ${stderr.slice(-500)}`);
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }

  return { baseUrl, port, process: serverProc, boosHome, stdout: () => stdout, stderr: () => stderr };
}

/**
 * Kill a BOOS server and wait for it to exit.
 * @param {object} server — the object returned by spawnServer()
 * @returns {Promise<void>}
 */
async function killServer(server) {
  if (!server || !server.process) return;

  const proc = server.process;
  if (proc.killed || proc.exitCode !== null) return;

  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 10000);

    proc.on('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });

    try { proc.kill('SIGTERM'); } catch { clearTimeout(forceTimer); resolve(); }
  });
}

module.exports = { spawnServer, killServer, findFreePort, waitForHealth };

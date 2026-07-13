// Global setup: start a BOOS server on a free port, then export the URL.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const BOOS_HOME = path.join(os.tmpdir(), `boos-e2e-${process.pid}-${Date.now()}`);
const PORT = 17777;

async function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.ok) return j;
      }
    } catch { /* server not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms at ${url}`);
}

module.exports = async function globalSetup() {
  // Create isolated BOOS_HOME with a config that pins the port.
  fs.mkdirSync(BOOS_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(BOOS_HOME, 'config.json'),
    JSON.stringify({
      port: PORT,
      workDir: path.join(BOOS_HOME, 'workspaces'),
      clis: [
        { id: 'claude', type: 'claude', name: 'Claude', command: 'claude',
          args: ['--resume', '--settings', '{"theme":"auto"}'],
          resumeLatestArgs: ['--continue'], resumePickerArgs: ['--resume'],
          shell: 'direct' },
      ],
      defaultCliId: 'claude',
      resumeMode: 'latest',
    }, null, 2),
    'utf8'
  );

  // Environment for the server process.
  const env = {
    ...process.env,
    BOOS_HOME,
    BOOS_NO_BROWSER: '1',
    BOOS_KEEP_ALIVE: '1',
    BOOS_PORT: String(PORT),
  };

  const serverJs = path.join(__dirname, '..', '..', 'server.js');
  const child = spawn(process.execPath, [serverJs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Collect stdout/stderr for debugging.
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const baseUrl = `http://localhost:${PORT}`;

  try {
    await waitForServer(baseUrl);
  } catch (e) {
    // Dump logs on failure.
    console.error('=== SERVER STDOUT ===\n' + stdout.slice(-4000));
    console.error('=== SERVER STDERR ===\n' + stderr.slice(-4000));
    try { child.kill(); } catch {}
    throw e;
  }

  // Store info for teardown and tests.
  const stateFile = path.join(BOOS_HOME, '.e2e-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    boosHome: BOOS_HOME,
    port: PORT,
    baseUrl,
    pid: child.pid,
  }));

  process.env.BOOS_E2E_STATE_FILE = stateFile;
  process.env.BOOS_E2E_URL = baseUrl;

  console.log(`[e2e] BOOS server ready at ${baseUrl} (pid=${child.pid})`);
};

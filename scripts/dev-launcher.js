// BOOS dev launcher — starts server in background, waits for health,
// opens browser to local dev frontend. Called by start.bat.
//
// Usage: node scripts/dev-launcher.js <projectDir>

'use strict';

const { spawn, exec } = require('child_process');
const path = require('path');
const http = require('http');

const PROJECT_DIR = process.argv[2] || process.cwd();
const SERVER_JS = path.join(__dirname, '..', 'server.js');
const LOG_FILE = path.join(__dirname, '..', 'server.log');

// ── read configured port ──────────────────────────────────────────

async function getPort() {
  try {
    const { loadConfig } = require('../lib/config');
    const cfg = await loadConfig();
    return cfg.port || 7777;
  } catch {
    return 7777;
  }
}

// ── health check ──────────────────────────────────────────────────

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

// ── send shutdown to previous instance ─────────────────────────────

function shutdownPrevious(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/shutdown', method: 'POST' }, () => resolve());
    req.on('error', () => resolve());
    req.setTimeout(2000, () => { req.destroy(); resolve(); });
    req.end();
  });
}

// ── open browser ───────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

// ── main ──────────────────────────────────────────────────────────

(async () => {
  const port = await getPort();

  console.log('==========================================');
  console.log('  BOOS Dashboard (Dev Mode)');
  console.log(`  Project : ${PROJECT_DIR}`);
  console.log(`  Port    : ${port}`);
  console.log(`  URL     : http://localhost:${port}`);
  console.log('==========================================');
  console.log('');

  // 1. Stop previous instance
  process.stdout.write('[1/3] Stopping previous instance... ');
  await shutdownPrevious(port);
  await new Promise((r) => setTimeout(r, 2000));
  console.log('done.');

  // 2. Start server in background
  process.stdout.write('[2/3] Starting server (background)... ');
  const logFd = require('fs').openSync(LOG_FILE, 'w');
  const server = spawn('node', [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, BOOS_NO_BROWSER: '1' },
  });
  server.unref();
  require('fs').closeSync(logFd);
  console.log('pid', server.pid);

  // 3. Wait for health
  process.stdout.write('[3/3] Waiting for server...');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthCheck(port)) {
      console.log(' ready!');
      console.log('');
      console.log(`  Opening browser -> http://localhost:${port}/`);
      console.log('  Local dev frontend (not GitHub Pages).');
      console.log('  Includes: Decisions, Sandbox, Constraints UI.');
      console.log('');
      openBrowser(`http://localhost:${port}/`);
      return;
    }
    process.stdout.write('.');
  }

  console.log('');
  console.log('[FAIL] Server did not respond within 30s.');
  console.log(`Check server.log: ${LOG_FILE}`);
  process.exit(1);
})();

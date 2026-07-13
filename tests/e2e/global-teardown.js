// Global teardown: stop the BOOS server and clean up.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function globalTeardown() {
  const stateFile = process.env.BOOS_E2E_STATE_FILE;
  if (!stateFile) {
    console.warn('[e2e] no state file — nothing to tear down');
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    console.warn('[e2e] could not read state file');
    return;
  }

  const { baseUrl, boosHome, pid } = state;

  // 1. Graceful shutdown via API.
  if (baseUrl) {
    try {
      await fetch(`${baseUrl}/api/shutdown`, { method: 'POST' });
      console.log(`[e2e] /api/shutdown sent`);
    } catch { /* server may already be down */ }
  }

  // 2. Wait up to 5 s for graceful exit.
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Force-kill if still alive.
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  // 4. Clean up temp BOOS_HOME.
  if (boosHome && fs.existsSync(boosHome)) {
    fs.rmSync(boosHome, { recursive: true, force: true });
    console.log(`[e2e] cleaned up ${boosHome}`);
  }

  // 5. Remove state file.
  try { fs.unlinkSync(stateFile); } catch {}
};

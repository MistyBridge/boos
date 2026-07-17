#!/usr/bin/env node
'use strict';

// Restart helper · spawned detached by /api/restart.
//
// Just like upgrade-helper but skips the `npm i` step. Server kicks
// this off + gracefulShutdowns; helper waits for the port to free, then
// respawns boos (which finds no live backend and starts a fresh one).
//
// Argv: node restart-helper.js <port> <pid>

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const oldPort = Number(process.argv[2] || 7780);
const oldPid = Number(process.argv[3] || 0);

const HOME = process.env.BOOS_HOME || path.join(os.homedir(), '.boos');
const LOG = path.join(HOME, 'restart.log');
try { fs.mkdirSync(HOME, { recursive: true }); } catch {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portFree(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let settled = false;
    const finish = (free) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(free); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(false));
    s.once('timeout', () => finish(true));
    s.once('error', () => finish(true));
    s.connect(port, '127.0.0.1');
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

(async () => {
  log(`start · oldPort=${oldPort} oldPid=${oldPid}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const free = await portFree(oldPort);
    const dead = !pidAlive(oldPid);
    if (free && dead) break;
    await sleep(250);
  }
  log(`old server gone (or 30s elapsed) · respawning`);

  const isWin = process.platform === 'win32';
  const boosCmd = isWin ? 'boos.cmd' : 'boos';
  // Inherit env but DROP BOOS_NO_BROWSER so the respawned server pops a
  // fresh browser window — the frontend that triggered the restart
  // called window.close() in parallel, and the new window takes its
  // place without the OfflineBanner gap.
  const childEnv = { ...process.env };
  delete childEnv.BOOS_NO_BROWSER;
  let exe, exeArgs;
  if (isWin) {
    exe = process.env.ComSpec || 'cmd.exe';
    exeArgs = ['/d', '/s', '/c', boosCmd];
  } else {
    exe = boosCmd;
    exeArgs = [];
  }
  try {
    const child = spawn(exe, exeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: childEnv,
    });
    child.unref();
    log(`respawned ${boosCmd} (via ${path.basename(exe)})`);
  } catch (e) {
    log(`respawn failed: ${e.message}`);
    process.exit(1);
  }
})().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// boos launcher · entry point for `boos` / `npx @MistyBridge/boos`.
//
// Two modes by how it's invoked:
//
//   plain `boos`           → start backend if not running, open a browser
//                            window pointing at it. Terminal returns to a
//                            prompt immediately (detached).
//
//   `boos boos://<action>` → fired by Windows when the user clicks a
//                            boos:// link (PWA offline banner). Same
//                            backend startup as above, but DO NOT spawn
//                            an extra browser — the PWA window that
//                            triggered the click is already open and
//                            will reconnect as soon as the backend
//                            becomes reachable.
//
// In both modes, if a server is already running we just ping it. New
// browser window opens only in the plain-`boos` case.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const HOME = process.env.BOOS_HOME || path.join(os.homedir(), '.boos');
const LOG  = path.join(HOME, 'server.log');

function loadPreferredPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    return Number(cfg.port) || 7777;
  } catch {
    return 7777;
  }
}

// Cheap "is this pid still alive" check using kill(pid, 0). Returns
// true for live pids we own, also true for pids in other security
// contexts (EPERM means it exists, we just can't signal it).
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function probe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.name === '@MistyBridge/boos' ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function post(port, pathname, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write('{}');
    req.end();
  });
}

// Detect boos:// protocol invocation. Windows runs us as
// `boos.cmd boos://start` when the user clicks a protocol link.
// argv layout: [node, boos.js, "boos://..."]
function parseProtocolArg() {
  const a = process.argv[2];
  if (!a || !/^boos:\/\//i.test(a)) return null;
  try {
    // Normalise: boos://start or boos://start?foo=bar
    const u = new URL(a);
    // host is the action (`start`, `restart`, ...); empty host means
    // the URL was `boos:start` or `boos:///action`
    const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    return { action, raw: a };
  } catch {
    return { action: '', raw: a };
  }
}

// Compare what's running with what's installed. Returns true if they
// match (or running is unknown). False means we should restart so the
// new code takes over after an `npm i -g @MistyBridge/boos@latest`.
function isSameVersion(running) {
  try {
    const installed = require('../package.json').version;
    return running.version === installed;
  } catch { return true; }
}

(async () => {
  const protocol = parseProtocolArg();
  const SILENT = !!protocol;  // boos:// invocations should not open a new browser
  const port = loadPreferredPort();

  // Upgrade-in-progress guard. The updater helper writes
  // ~/.boos/.upgrade.lock at start. If a boos:// click (or any other
  // launcher trigger) races during an in-flight install, spawning a
  // new server would: (a) fight npm for the package dir, EBUSY; or
  // (b) bind port 7777 before the helper's own respawn does. Either
  // way the upgrade derails. Bail out instead — the helper's UI on
  // 7779 is already showing the user what's happening.
  //
  // Exception: the helper itself spawns boos.cmd at the END of the
  // upgrade (after npm install completes) to bring the new backend up.
  // It sets BOOS_FROM_UPGRADE=1 in that child's env. We MUST skip the
  // lock check in that case, otherwise we'd refuse our own respawn and
  // the user would be stuck staring at "Backend not running".
  if (process.env.BOOS_FROM_UPGRADE !== '1') {
    const lockPath = path.join(HOME, '.upgrade.lock');
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const lock = JSON.parse(raw);
      const ageMs = Date.now() - (lock.startedAt || 0);
      const ownerAlive = lock.pid ? pidAlive(lock.pid) : false;
      if (ownerAlive && ageMs < 10 * 60_000) {
        console.log(`boos: upgrade in progress (helper pid=${lock.pid}, ${Math.round(ageMs/1000)}s ago, target=${lock.target || '?'})`);
        console.log(`  see http://localhost:${lock.helperPort || 7779}/ for live progress`);
        process.exit(0);
      }
      // Stale lock (pid dead OR > 10min) — clean up and continue.
      try { fs.unlinkSync(lockPath); } catch {}
    } catch {
      // ENOENT or parse error → no lock, proceed.
    }
  }

  // Case 1: existing instance on the preferred port
  let existing = await probe(port);

  // If an old version is running, ask it to shut down so the freshly
  // installed code can take over. The launcher then falls through to
  // Case 2 and spawns the new server itself.
  if (existing && !isSameVersion(existing)) {
    const installed = require('../package.json').version;
    console.log(`boos upgrading · running v${existing.version} → installed v${installed}`);
    await post(port, '/api/shutdown');
    // Wait for the old process to actually exit so its port frees up.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await probe(port, 200))) { existing = null; break; }
    }
  }

  if (existing) {
    if (!SILENT) {
      const opened = await post(port, '/api/spawn-browser');
      console.log(`boos already running · v${existing.version} · http://localhost:${port}`);
      if (!opened) console.log('(could not open a new window — server might be busy)');
    } else {
      console.log(`boos already running · ${protocol.raw}`);
    }
    return;
  }

  // Case 2: spawn detached server
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] boos starting (protocol=${protocol?.raw || '-'})...\n`);

  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      // Suppress the server's own auto-spawn of a browser when this launch
      // came from a boos:// click — the PWA window that fired it is the
      // browser, and a second window would just be noise.
      ...(SILENT ? { BOOS_NO_BROWSER: '1' } : {}),
    },
  });
  child.unref();

  // Poll /api/health for up to ~10s. Once it answers we know the server
  // is fully booted (port is bound, config loaded, snapshot loop running).
  // The actual port may differ from the preferred one if it was taken,
  // so on each iteration we re-probe the preferred port first, then fall
  // back to scanning preferred+1..preferred+9.
  const portsToTry = [port, ...Array.from({ length: 9 }, (_, i) => port + i + 1)];
  let actualPort = null;
  let ready = null;
  outer:
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    for (const p of portsToTry) {
      const r = await probe(p, 300);
      if (r) { ready = r; actualPort = p; break outer; }
    }
  }
  if (!ready) {
    console.error(`boos server did not come up in 10s. Check ${LOG}`);
    process.exit(1);
  }
  console.log(`boos started · v${ready.version}`);
  console.log(`backend:  http://localhost:${actualPort}${actualPort !== port ? `  (preferred ${port} was taken)` : ''}`);
  console.log(`frontend: https://MistyBridge.github.io/boos/v1/`);
  console.log(`logs:     ${LOG}`);

  // First-run hint — printed once, then a marker file makes us quiet.
  const firstRunMark = path.join(HOME, '.first-run-shown');
  if (!fs.existsSync(firstRunMark)) {
    try { fs.writeFileSync(firstRunMark, new Date().toISOString()); } catch {}
    console.log('');
    console.log('First run · boos is now running in the background.');
    console.log('Open the frontend URL above, click "Install boos" in your browser');
    console.log('to install it as a PWA so the icon launches directly into the app.');
  }
})().catch((err) => {
  console.error('boos launcher failed:', err);
  process.exit(1);
});

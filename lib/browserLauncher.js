// Browser launcher extracted from server.js — find Edge/Chrome, detect
// installed BOOS PWA, and open the frontend in the best available window.
//
// Exports:
//   findAppModeBrowser, findInstalledCcsmPwa, openInBrowser

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// ── browser discovery ──────────────────────────────────────────────────

function findAppModeBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── installed PWA detection ────────────────────────────────────────────

function findInstalledCcsmPwa() {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const dirs = [path.join(startMenu, 'Chrome Apps'), path.join(startMenu, 'Edge Apps')];
  const candidates = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      if (!/boos/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        candidates.push({ name, path: full, mtime: fs.statSync(full).mtimeMs });
      } catch {}
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  const { spawnSync } = require('node:child_process');
  const psPaths = candidates.map((c) => `'${c.path.replace(/'/g, "''")}'`).join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$wsh = New-Object -ComObject WScript.Shell
foreach ($p in @(${psPaths})) {
  $sc = $wsh.CreateShortcut($p)
  Write-Output ($sc.TargetPath + '|' + $sc.Arguments)
}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sep = line.indexOf('|');
    if (sep < 0) continue;
    const target = line.slice(0, sep).trim();
    const args = line.slice(sep + 1).trim();
    if (!/chrome(_proxy)?\.exe$|msedge(_proxy)?\.exe$/i.test(target)) continue;
    const appId = (args.match(/--app-id=(\S+)/) || [])[1];
    if (!appId) continue;
    const profile = (args.match(/--profile-directory=(\S+)/) || [])[1] || 'Default';
    return { browserPath: target, appId, profile };
  }
  return null;
}

// ── open frontend ──────────────────────────────────────────────────────

function openInBrowser(url, DATA_DIR) {
  if (process.platform !== 'win32') return { kind: 'none', child: null };
  const { spawn } = require('node:child_process');

  const installed = findInstalledCcsmPwa();
  if (installed) {
    console.log(`[boos] launching installed PWA · app-id=${installed.appId} profile=${installed.profile}`);
    const child = spawn(
      installed.browserPath,
      [`--profile-directory=${installed.profile}`, `--app-id=${installed.appId}`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { kind: 'pwa', child };
  }

  const exe = findAppModeBrowser();
  if (exe) {
    const profileDir = path.join(DATA_DIR, 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    console.log('[boos] no installed PWA found · falling back to --app= window');
    const child = spawn(
      exe,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1500,1100',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { kind: 'app', child };
  }

  console.log('[boos] no Edge/Chrome found, opening default browser');
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { kind: 'tab', child: null };
}

module.exports = { findAppModeBrowser, findInstalledCcsmPwa, openInBrowser };

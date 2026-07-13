#!/usr/bin/env node
'use strict';

// boos postinstall · Windows-only · runs after `npm install -g @MistyBridge/boos`.
// Registers the `boos://` URL protocol in HKCU so the hosted frontend
// (https://MistyBridge.github.io/boos/v1/) can fire `<a href="boos://start">`
// from its OfflineBanner and have Windows spawn the backend on demand.
//
// Best-effort: any failure MUST NOT break npm install. Each step is in
// its own try/catch; we just log and move on.
//
// No .lnk file, no Start Menu shortcut — just the protocol handler.

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function log(msg)  { process.stdout.write(`[boos install] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[boos install] ${msg}\n`); }

if (process.platform !== 'win32') {
  log('non-Windows · skipping boos:// registration');
  process.exit(0);
}
// Note: we DO register on npx-cache installs too (not just global). The
// npx cache path is stable across re-runs of the same package, and even
// if the user later cleans the cache, the only consequence is the
// OfflineBanner button no-ops — nothing actively broken. Registering
// always means a first-time `npx @MistyBridge/boos` gets the full "click
// to wake" UX without needing a separate `npm i -g`.

// Returns { boosCmd, isSandbox } where isSandbox=true means this install
// went into a non-default prefix (e.g. `npm i -g --prefix=<tmp>` from
// the in-app upgrade's test mode). For sandboxed installs we DO NOT
// touch the global launcher.vbs / boos:// protocol registration —
// otherwise we'd repoint them at a directory that gets deleted later.
function findCcsmCmd() {
  const givenPrefix = process.env.npm_config_prefix || null;
  let defaultPrefix = null;
  try {
    // npm config get prefix when run WITHOUT --prefix returns the
    // user's default global prefix; with --prefix it echoes the flag.
    // We want the env-independent default so we can compare. INIT_CWD
    // and a clean spawn give us the user-default value.
    const r = spawnSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf8', shell: true,
      env: { ...process.env, npm_config_prefix: '' },
    });
    defaultPrefix = r.stdout?.trim() || null;
  } catch {}
  const prefix = givenPrefix || defaultPrefix;
  if (!prefix) return { boosCmd: null, isSandbox: false };
  const candidate = path.join(prefix, 'boos.cmd');
  const isSandbox = !!(givenPrefix && defaultPrefix
    && path.resolve(givenPrefix).toLowerCase() !== path.resolve(defaultPrefix).toLowerCase());
  return {
    boosCmd: fs.existsSync(candidate) ? candidate : null,
    isSandbox,
  };
}

// Write a tiny VBScript wrapper that boos:// dispatches into. Why VBS:
// wscript.exe is a Windows-subsystem host (no console window), and
// `Shell.Run(..., 0, False)` launches the target completely hidden — so
// when the user clicks boos://start, NOTHING flashes on screen, the
// backend just appears in the next health probe.
function writeLauncherVbs(boosCmd) {
  const home = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!home) throw new Error('no LOCALAPPDATA/APPDATA env var');
  const dir = path.join(home, 'boos');
  fs.mkdirSync(dir, { recursive: true });
  const vbsPath = path.join(dir, 'launcher.vbs');
  // Escape any double-quotes in the cmd path (rare but possible).
  const cmdEsc = boosCmd.replace(/"/g, '""');
  const vbs = [
    "' boos protocol launcher · invoked by wscript.exe via the registered",
    "' boos:// URL handler. Spawns boos.cmd with WindowStyle 0 (hidden) +",
    "' bWaitOnReturn=False (async), so the click leaves zero visible trace.",
    'If WScript.Arguments.Count >= 1 Then',
    '  arg = WScript.Arguments(0)',
    'Else',
    '  arg = ""',
    'End If',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${cmdEsc}"" """ & arg & """", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, { encoding: 'utf8' });
  return vbsPath;
}

function registerProtocol(vbsPath) {
  // wscript.exe is a no-console host. The protocol-registered command
  // hands the entire boos:// URL to launcher.vbs as argv[0]; the VBS
  // forwards it to boos.cmd "%1" with a hidden window.
  const command = `wscript.exe "${vbsPath}" "%1"`;
  const root = 'HKCU\\Software\\Classes\\boos';
  const calls = [
    ['add', root, '/ve', '/d', 'URL:boos protocol', '/f'],
    ['add', root, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${root}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
  ];
  for (const args of calls) {
    const r = spawnSync('reg.exe', args, { windowsHide: true });
    if (r.status !== 0) {
      throw new Error(`reg ${args.join(' ')} → exit ${r.status}: ${r.stderr?.toString() || ''}`);
    }
  }
}

const { boosCmd, isSandbox } = (() => {
  try { return findCcsmCmd(); } catch { return { boosCmd: null, isSandbox: false }; }
})();
if (!boosCmd) {
  warn('could not locate boos.cmd · skipping protocol registration');
  process.exit(0);
}
if (isSandbox) {
  log(`sandbox install detected (prefix=${process.env.npm_config_prefix}) · skipping global launcher.vbs + protocol registration + auto-launch`);
  process.exit(0);
}

try {
  const vbsPath = writeLauncherVbs(boosCmd);
  registerProtocol(vbsPath);
  log(`launcher · ${vbsPath}`);
  log(`boos:// protocol registered (silent · via wscript.exe)`);
} catch (e) {
  warn(`failed · ${e.message}`);
  warn('the hosted frontend\'s "Start boos" button will not be able to launch the backend. You can still run `boos` manually in a terminal.');
}

// Open the hosted setup guide. The page walks the user through the
// remaining one-time setup (allow boos:// protocol, firewall, install
// as PWA) and Step 1's "Try boos://start" button doubles as boos
// auto-launch — so we don't need a separate spawn here. Set
// BOOS_NO_AUTOLAUNCH=1 to skip (CI, headless setups).
if (process.env.BOOS_NO_AUTOLAUNCH !== '1') {
  try {
    // `start` on Windows opens the default browser without attaching a
    // console. Run via cmd.exe /c since `start` is a cmd builtin.
    require('node:child_process').spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'start', '', 'https://MistyBridge.github.io/boos/setup/'],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).unref();
    log('opened setup guide · https://MistyBridge.github.io/boos/setup/');
    log('(set BOOS_NO_AUTOLAUNCH=1 to skip this on future installs)');
  } catch (e) {
    warn(`setup guide open failed · ${e.message}`);
    warn('run `boos` manually to start.');
  }
}

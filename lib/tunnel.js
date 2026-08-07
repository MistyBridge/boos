// Tunnel manager — spawns and supervises cloudflared/devtunnel child process.
//
// Two providers: cloudflared (quick tunnels, no login) and devtunnel
// (persistent tunnels, requires Microsoft login).
//
// Split across 2 modules (Sprint 31 — ≤500 lines each):
//   tunnel.js          — core: start/stop/status/probe (this file)
//   tunnelDevtunnel.js — devtunnel: login, tunnel ID, port/access config

'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const { loadConfig, saveConfig } = require('./config');
const execFileP = promisify(execFile);

const devtunnel = require('./tunnelDevtunnel');
const errReport = require("./errorReport");

const PROVIDERS = {
  cloudflared: {
    id: 'cloudflared', label: 'Cloudflare Tunnel',
    wingetId: 'Cloudflare.cloudflared', binary: 'cloudflared.exe',
    knownPaths: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    ],
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`],
    urlRegex: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  },
  devtunnel: {
    id: 'devtunnel', label: 'Microsoft Dev Tunnel',
    wingetId: 'Microsoft.devtunnel', binary: 'devtunnel.exe',
    knownPaths: [
      path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages',
        'Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe', 'devtunnel.exe'),
    ],
    args: (port, opts = {}) => {
      if (opts.tunnelId) return ['host', opts.tunnelId];
      return ['host', '-p', String(port), '--allow-anonymous'];
    },
    urlRegex: /https:\/\/[a-z0-9]+-\d+\.[a-z0-9-]+\.devtunnels\.ms/i,
    needsLogin: true,
  },
};

// ── In-memory state ────────────────────────────────────────────────────

let current = null;
let starting = false;
let token = null;

function getToken() { return token; }
function setToken(t) { token = t ? String(t) : null; return token; }

// ── Binary discovery ────────────────────────────────────────────────────

async function findBinary(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  try {
    const { stdout } = await execFileP('where.exe', [p.binary], { windowsHide: true });
    const out = String(stdout).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {
    // Expected when the binary isn't installed — tunnel is an optional
    // feature. warn-level skip, not an error.
    errReport.skip('tunnel', 'findBinary', 'binary not found (optional feature)', { binary: p.binary });
  }
  for (const candidate of p.knownPaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  if (provider === 'devtunnel') {
    const base = path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of fs.readdirSync(base)) {
        if (entry.startsWith('Microsoft.devtunnel_')) {
          const candidate = path.join(base, entry, 'devtunnel.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch (e) { errReport.skip('tunnel', 'winGet-scan', 'packages dir unreadable (optional feature)', { base }); }
  }
  return null;
}

async function getVersion(provider, exe) {
  try {
    const { stdout } = await execFileP(exe, ['--version'], { windowsHide: true });
    return String(stdout).trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

// ── Probe ───────────────────────────────────────────────────────────────

const PROBE_TTL_MS = 30_000;
let probeCache = null;
let probeCacheAt = 0;

async function probe(force = false) {
  if (!force && probeCache && Date.now() - probeCacheAt < PROBE_TTL_MS) return probeCache;
  const ids = Object.keys(PROVIDERS);
  const results = await Promise.all(ids.map(async (id) => {
    const exe = await findBinary(id);
    const p = { installed: !!exe, exe, version: null };
    if (exe) {
      const tasks = [getVersion(id, exe)];
      if (id === 'devtunnel') tasks.push(devtunnel.checkDevtunnelLogin(exe));
      const [version, devUser] = await Promise.all(tasks);
      p.version = version;
      if (devUser) Object.assign(p, devUser);
    }
    return [id, p];
  }));
  probeCache = Object.fromEntries(results);
  probeCacheAt = Date.now();
  return probeCache;
}

let probeRefreshing = null;
function kickProbeRefresh() {
  if (!probeRefreshing) {
    probeRefreshing = probe(true).catch(() => probeCache).finally(() => { probeRefreshing = null; });
  }
  return probeRefreshing;
}

function invalidateProbe() { probeCache = null; probeCacheAt = 0; kickProbeRefresh(); }

function probeCachedSWR() {
  const fresh = probeCache && Date.now() - probeCacheAt < PROBE_TTL_MS;
  if (!fresh) kickProbeRefresh();
  return probeCache;
}

// ── Status ──────────────────────────────────────────────────────────────

async function status() {
  let cfg = null;
  try {  cfg = await loadConfig();  } catch (e) { errReport.report("tunnel", "loadConfig", e); }
  return {
    providers: probeCachedSWR(),
    running: !!current, provider: current?.provider || null,
    url: current?.url || null, startedAt: current?.startedAt || null,
    pid: current?.child?.pid || null, log: current?.log?.slice(-50) || [],
    token, tunnelId: current?.tunnelId || cfg?.devtunnel?.tunnelId || null,
    autoStart: cfg?.tunnel?.autoStart ?? false,
    autoStartProvider: cfg?.tunnel?.provider ?? null,
    login: devtunnel.loginSnapshot(),
  };
}

// ── Start / Stop ────────────────────────────────────────────────────────

async function start({ provider, port }) {
  if (current) throw new Error('tunnel already running');
  if (starting) throw new Error('tunnel is already starting');
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);

  starting = true;
  let entry, child;
  try {
    const exe = await findBinary(provider);
    if (!exe) throw new Error(`${p.label} is not installed`);
    if (provider === 'devtunnel') {
      const { loggedIn } = await devtunnel.checkDevtunnelLogin(exe);
      if (!loggedIn) throw new Error('devtunnel requires login — run `devtunnel user login` first');
    }

    let tunnelId = null;
    if (provider === 'devtunnel') {
      tunnelId = await devtunnel.ensureDevtunnelTunnelId(exe);
      if (tunnelId) await devtunnel.configureDevtunnelTunnel(exe, tunnelId, port);
    }

    const args = p.args(port, { tunnelId });
    child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    entry = { provider, child, url: null, startedAt: Date.now(), log: [], tunnelId };
    current = entry;
  } finally { starting = false; }

  const pushLog = (line) => {
    entry.log.push(line);
    if (entry.log.length > 200) entry.log.shift();
    if (!entry.url) { const m = line.match(p.urlRegex); if (m) entry.url = m[0]; }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));
  child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));

  child.on('exit', (code, signal) => {
    if (current === entry) current = null;
    console.log(`[tunnel] ${provider} exited · code=${code} signal=${signal || ''}`);
  });
  child.on('error', (err) => {
    if (current === entry) current = null;
    console.error(`[tunnel] ${provider} spawn error`, err);
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (entry.url) return await status();
    if (!current || current !== entry) {
      throw new Error('tunnel exited before reporting a URL · ' + entry.log.slice(-3).join(' / '));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return await status();
}

function stop() {
  if (!current) return false;
  try {  current.child.kill();  } catch (e) { errReport.report("tunnel", "kill", e); }
  current = null;
  return true;
}

// ── Install ─────────────────────────────────────────────────────────────

function installViaWinget(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (process.platform !== 'win32') throw new Error('winget install only supported on Windows');
  const child = spawn('winget', [
    'install', p.wingetId, '--accept-source-agreements', '--accept-package-agreements', '--silent',
  ], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return { provider, pid: child.pid };
}

// ── Dev-tunnel delegation ───────────────────────────────────────────────

async function startDevtunnelLogin(opts) {
  return devtunnel.startDevtunnelLogin(opts, { findBinary, invalidateProbe });
}

async function resetDevtunnelTunnelId() {
  return devtunnel.resetDevtunnelTunnelId({ findBinary });
}

module.exports = {
  PROVIDERS,
  probe, status, start, stop, installViaWinget,
  getToken, setToken,
  startDevtunnelLogin,
  cancelDevtunnelLogin: devtunnel.cancelDevtunnelLogin,
  clearDevtunnelLogin: devtunnel.clearDevtunnelLogin,
  invalidateProbe,
  resetDevtunnelTunnelId,
};

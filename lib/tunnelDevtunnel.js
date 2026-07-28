// Dev-tunnel specific operations — login flow, tunnel ID management,
// port/access configuration, and tunnel ID reset.
//
// Extracted from tunnel.js (Sprint 31 refactor — ≤500 lines).

'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const { loadConfig, saveConfig } = require('./config');
const execFileP = promisify(execFile);

// ── Dev-tunnel login (device-code flow) ────────────────────────────────

let login = null;

function loginSnapshot() {
  if (!login) return null;
  return {
    mode: login.mode, status: login.status, url: login.url, code: login.code,
    error: login.error || null, user: login.user || null,
    startedAt: login.startedAt, finishedAt: login.finishedAt || null,
    lines: login.lines.slice(-40),
  };
}

function getLogin() { return login; }
function clearLogin() { login = null; }

async function startDevtunnelLogin({ mode = 'microsoft' } = {}, { findBinary, invalidateProbe }) {
  if (login && login.status === 'running') return loginSnapshot();
  const exe = await findBinary('devtunnel');
  if (!exe) throw new Error('Microsoft Dev Tunnel is not installed');
  invalidateProbe();

  const args = mode === 'github' ? ['user', 'login', '-g', '-d'] : ['user', 'login', '-d'];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const entry = {
    child, mode, lines: [], url: null, code: null,
    status: 'running', error: null, user: null,
    startedAt: Date.now(), finishedAt: null,
  };
  login = entry;

  const URL_RE = /https?:\/\/\S+/i;
  const CODE_RE = /\b([A-Z0-9]{4,}-?[A-Z0-9]{3,})\b/;
  const LOGGED = /Logged in as (\S+)/i;

  const ingest = (line) => {
    if (!line) return;
    entry.lines.push(line);
    if (entry.lines.length > 100) entry.lines.shift();
    if (!entry.url) { const m = line.match(URL_RE); if (m) entry.url = m[0].replace(/[.,)]+$/, ''); }
    if (!entry.code && /code/i.test(line)) {
      const sans = line.replace(URL_RE, '');
      const m = sans.match(CODE_RE);
      if (m) entry.code = m[1];
    }
    const u = line.match(LOGGED);
    if (u) entry.user = u[1];
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => c.split(/\r?\n/).forEach(ingest));
  child.stderr.on('data', (c) => c.split(/\r?\n/).forEach(ingest));

  child.on('exit', (code, signal) => {
    entry.finishedAt = Date.now();
    if (entry.status === 'canceled') { /* leave as-is */ }
    else if (code === 0) { entry.status = 'done'; invalidateProbe(); }
    else { entry.status = 'error'; entry.error = `devtunnel exited code=${code}${signal ? ` signal=${signal}` : ''}`; }
  });
  child.on('error', (err) => {
    entry.status = 'error';
    entry.error = String(err && err.message || err);
    entry.finishedAt = Date.now();
  });

  return loginSnapshot();
}

function cancelDevtunnelLogin() {
  if (!login || login.status !== 'running') return loginSnapshot();
  login.status = 'canceled';
  login.finishedAt = Date.now();
  try { login.child.kill(); } catch {}
  return loginSnapshot();
}

function clearDevtunnelLogin() {
  if (login && login.status === 'running') { try { login.child.kill(); } catch {} }
  login = null;
  return null;
}

// ── Tunnel ID management ───────────────────────────────────────────────

async function ensureDevtunnelTunnelId(exe) {
  try {
    const cfg = await loadConfig();
    if (cfg?.devtunnel?.tunnelId) return cfg.devtunnel.tunnelId;
    const { stdout } = await execFileP(exe, ['create', '--json'], { windowsHide: true, timeout: 20_000 });
    let id = null;
    try {
      const j = JSON.parse(String(stdout));
      id = j.tunnelId || j.tunnel?.tunnelId || j.id || null;
    } catch {
      const m = String(stdout).match(/Tunnel ID:\s*(\S+)/i);
      if (m) id = m[1];
    }
    if (!id) return null;
    try { await saveConfig({ devtunnel: { tunnelId: id } }); } catch (e) { console.warn('[tunnel] persist devtunnel id failed:', e.message); }
    return id;
  } catch (e) { console.warn('[tunnel] ensureDevtunnelTunnelId failed:', e.message); return null; }
}

async function configureDevtunnelTunnel(exe, tunnelId, port) {
  if (!tunnelId) return;
  try {
    await execFileP(exe, ['port', 'create', tunnelId, '-p', String(port)], { windowsHide: true, timeout: 10_000 });
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '');
    if (!/already/i.test(msg)) console.warn('[tunnel] devtunnel port create failed:', msg.slice(0, 200));
  }
  try {
    await execFileP(exe, ['access', 'create', tunnelId, '-a'], { windowsHide: true, timeout: 10_000 });
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '');
    if (!/already/i.test(msg)) console.warn('[tunnel] devtunnel access create failed:', msg.slice(0, 200));
  }
}

async function resetDevtunnelTunnelId({ findBinary }) {
  let prevId = null;
  try { const cfg = await loadConfig(); prevId = cfg?.devtunnel?.tunnelId || null; } catch {}
  try { await saveConfig({ devtunnel: { tunnelId: null } }); } catch {}
  if (prevId) {
    const exe = await findBinary('devtunnel');
    if (exe) {
      try { await execFileP(exe, ['delete', prevId, '-f'], { windowsHide: true, timeout: 5_000 }); } catch {}
    }
  }
  return { previousTunnelId: prevId };
}

async function checkDevtunnelLogin(exe) {
  try {
    const { stdout } = await execFileP(exe, ['user', 'show'], { windowsHide: true, timeout: 5000 });
    const m = String(stdout).trim().match(/Logged in as (\S+)/);
    if (m) return { loggedIn: true, user: m[1] };
    return { loggedIn: false, user: null };
  } catch { return { loggedIn: false, user: null }; }
}

module.exports = {
  loginSnapshot, getLogin, clearLogin,
  startDevtunnelLogin, cancelDevtunnelLogin, clearDevtunnelLogin,
  ensureDevtunnelTunnelId, configureDevtunnelTunnel, resetDevtunnelTunnelId,
  checkDevtunnelLogin,
};

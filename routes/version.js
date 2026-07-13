// Version check + upgrade routes.
// Replaces inline handlers in server.js — /api/version, /api/upgrade.
//
// register(app, deps)
//   deps: { asyncH, pkg, gracefulShutdown, getState }

'use strict';

const path = require('node:path');
const os = require('node:os');

const VERSION_CACHE_MS = 30 * 60_000;
let versionCache = null;
let upgradeInFlight = false;

async function fetchLatestFromNpm() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://registry.npmjs.org/@MistyBridge%2Fboos/latest', {
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
    const j = await r.json();
    return String(j.version || '');
  } finally {
    clearTimeout(t);
  }
}

function cmpSemver(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function register(app, { asyncH, pkg, gracefulShutdown, getState }) {

  app.get('/api/version', asyncH(async (req, res) => {
    const force = String(req.query.refresh || '') === '1';
    const now = Date.now();
    const devMode = process.env.BOOS_DEV === '1';
    if (!force && versionCache && (now - versionCache.fetchedAt) < VERSION_CACHE_MS) {
      return res.json({
        current: pkg.version,
        latest: versionCache.latest,
        updateAvailable: cmpSemver(versionCache.latest, pkg.version) > 0,
        fetchedAt: versionCache.fetchedAt,
        cached: true,
        devMode,
      });
    }
    try {
      const latest = await fetchLatestFromNpm();
      versionCache = { latest, fetchedAt: now };
      res.json({
        current: pkg.version,
        latest,
        updateAvailable: cmpSemver(latest, pkg.version) > 0,
        fetchedAt: now,
        cached: false,
        devMode,
      });
    } catch (e) {
      res.json({
        current: pkg.version,
        latest: null,
        updateAvailable: false,
        fetchedAt: now,
        error: String(e.message || e),
        devMode,
      });
    }
  }));

  app.post('/api/upgrade', asyncH(async (req, res) => {
    if (upgradeInFlight) {
      return res.status(409).json({ error: 'upgrade already in progress' });
    }
    const body = req.body || {};
    const target = String(body.target || 'latest');
    if (!/^[a-z0-9.+\-^~]+$/i.test(target)) {
      return res.status(400).json({ error: `invalid target: ${target}` });
    }
    const installPrefix = body.installPrefix ? String(body.installPrefix) : '';
    if (installPrefix && (installPrefix.startsWith('-') || !path.isAbsolute(installPrefix))) {
      return res.status(400).json({ error: 'installPrefix must be an absolute path' });
    }
    const respawn = body.respawn === false ? '0' : '1';
    upgradeInFlight = true;
    console.log(`[upgrade] target=${target}${installPrefix ? ` prefix=${installPrefix}` : ''}${respawn === '0' ? ' (no respawn)' : ''}`);

    const fsp = require('node:fs/promises');
    const helperSrc = path.join(__dirname, '..', 'scripts', 'upgrade-helper.js');
    const helperTmp = path.join(os.tmpdir(), `boos-upgrade-${process.pid}-${Date.now()}.js`);
    try {
      await fsp.copyFile(helperSrc, helperTmp);
    } catch (e) {
      upgradeInFlight = false;
      return res.status(500).json({ error: `helper copy failed: ${e.message}` });
    }

    const state = getState();
    const redirectTo = state.frontendUrl || `http://localhost:${state.currentPort}/`;
    const args = [helperTmp, target, String(state.currentPort), String(process.pid), installPrefix, respawn, redirectTo];

    res.json({
      ok: true, started: true, target,
      helper: helperTmp,
      helperUrl: 'http://localhost:7779/',
      closeFrontend: false,
    });

    setImmediate(() => {
      const { spawn } = require('node:child_process');
      try {
        const child = spawn(process.execPath, args, {
          detached: true, stdio: 'ignore', windowsHide: true, shell: false,
        });
        child.unref();
        console.log(`[upgrade] helper pid=${child.pid}, shutting down`);
      } catch (e) {
        console.error('[upgrade] helper spawn failed:', e.message);
        upgradeInFlight = false;
        return;
      }
      setTimeout(() => gracefulShutdown('upgrade'), 500);
    });
  }));
}

module.exports = { register };

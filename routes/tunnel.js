// Remote tunnel routes.
// Replaces inline handlers in server.js — tunnel status, start, stop, token,
// autostart, install, devtunnel login flow, reset.
//
// register(app, deps)
//   deps: { asyncH, tunnel, saveConfig, getState }

'use strict';

function register(app, { asyncH, tunnel, saveConfig, getState }) {

  // ---- status ----
  app.get('/api/tunnel/status', asyncH(async (_req, res) => {
    res.json(await tunnel.status());
  }));

  // ---- start ----
  app.post('/api/tunnel/start', asyncH(async (req, res) => {
    const { provider, token } = req.body || {};
    if (!token || String(token).length < 8) {
      return res.status(400).json({ error: 'token required (≥ 8 chars)' });
    }
    tunnel.setToken(token);
    try {
      const result = await tunnel.start({ provider, port: getState().currentPort });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message, providers: await tunnel.probe().catch(() => ({})) });
    }
  }));

  // ---- stop ----
  app.post('/api/tunnel/stop', asyncH(async (_req, res) => {
    const stopped = tunnel.stop();
    res.json({ stopped, ...(await tunnel.status()) });
  }));

  // ---- token ----
  app.post('/api/tunnel/token', asyncH(async (req, res) => {
    const t = (req.body && req.body.token) || '';
    tunnel.setToken(t);
    res.json(await tunnel.status());
  }));

  // ---- autostart ----
  app.post('/api/tunnel/autostart', asyncH(async (req, res) => {
    const { autoStart, provider, token } = req.body || {};
    if (autoStart) {
      if (!token || String(token).length < 8) {
        return res.status(400).json({ error: 'token required (≥ 8 chars)' });
      }
      if (!['devtunnel', 'cloudflared'].includes(provider)) {
        return res.status(400).json({ error: 'valid provider required' });
      }
      tunnel.setToken(token);
      await saveConfig({ tunnel: { autoStart: true, provider, token } });
    } else {
      await saveConfig({ tunnel: { autoStart: false, provider: null, token: null } });
    }
    res.json(await tunnel.status());
  }));

  // ---- install ----
  app.post('/api/tunnel/install', asyncH(async (req, res) => {
    const { provider } = req.body || {};
    try {
      const r = tunnel.installViaWinget(provider);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  // ---- devtunnel login ----
  app.post('/api/tunnel/devtunnel/login', asyncH(async (req, res) => {
    const { mode } = req.body || {};
    try {
      const snap = await tunnel.startDevtunnelLogin({ mode });
      res.json({ ok: true, login: snap });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  app.post('/api/tunnel/devtunnel/login/cancel', asyncH(async (_req, res) => {
    res.json({ ok: true, login: tunnel.cancelDevtunnelLogin() });
  }));

  app.post('/api/tunnel/devtunnel/login/dismiss', asyncH(async (_req, res) => {
    tunnel.clearDevtunnelLogin();
    res.json({ ok: true });
  }));

  // ---- devtunnel reset ----
  app.post('/api/tunnel/devtunnel/reset', asyncH(async (_req, res) => {
    const s = await tunnel.status();
    if (s.running && s.provider === 'devtunnel') {
      return res.status(409).json({ error: 'stop the tunnel before resetting its id' });
    }
    const r = await tunnel.resetDevtunnelTunnelId();
    res.json({ ok: true, ...r, ...(await tunnel.status()) });
  }));
}

module.exports = { register };

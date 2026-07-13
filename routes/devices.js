// Device approval routes.
// Replaces inline handlers in server.js — devices/me, list, approve, reject,
// revoke, rename, delete.
//
// register(app, deps)
//   deps: { asyncH, devices, tunnel, isDirectLoopback }

'use strict';

function register(app, { asyncH, devices, tunnel, isDirectLoopback }) {

  app.get('/api/devices/me', asyncH(async (req, res) => {
    const id = String(req.headers['x-device-id'] || (req.query && req.query.device) || '');
    if (!id) return res.status(400).json({ error: 'device id required' });
    const existing = await devices.get(id);
    if (!existing) {
      const tok = tunnel.getToken();
      if (tok && !isDirectLoopback(req)) {
        const auth = req.headers.authorization || '';
        const qTok = req.query && req.query.token;
        if (auth !== `Bearer ${tok}` && qTok !== tok) {
          return res.status(401).json({ error: 'token required to register a new device' });
        }
      }
    }
    const ua = req.headers['user-agent'] || '';
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const code = String(req.headers['x-device-code'] || (req.query && req.query.code) || '').slice(0, 8);
    const d = await devices.record(id, { userAgent: ua, ip, code });
    res.json(d);
  }));

  app.get('/api/devices', asyncH(async (_req, res) => {
    res.json({ devices: await devices.list() });
  }));

  app.post('/api/devices/:id/approve', asyncH(async (req, res) => {
    const d = await devices.approve(req.params.id, req.body && req.body.label);
    if (!d) return res.status(404).json({ error: 'device not found' });
    res.json(d);
  }));

  app.post('/api/devices/:id/reject', asyncH(async (req, res) => {
    const d = await devices.reject(req.params.id);
    if (!d) return res.status(404).json({ error: 'device not found' });
    res.json(d);
  }));

  app.post('/api/devices/:id/revoke', asyncH(async (req, res) => {
    const d = await devices.revoke(req.params.id);
    if (!d) return res.status(404).json({ error: 'device not found' });
    res.json(d);
  }));

  app.put('/api/devices/:id', asyncH(async (req, res) => {
    const d = await devices.rename(req.params.id, (req.body && req.body.label) || '');
    if (!d) return res.status(404).json({ error: 'device not found' });
    res.json(d);
  }));

  app.delete('/api/devices/:id', asyncH(async (req, res) => {
    const removed = await devices.remove(req.params.id);
    res.json({ removed });
  }));
}

module.exports = { register };

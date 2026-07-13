// Shared Express middleware — extracted from server.js.
//
// Provides:
//   asyncH(fn)         — async error wrapper for route handlers
//   corsMiddleware      — CORS for MistyBridge.github.io origin
//   isDirectLoopback    — detect local vs. tunnel/proxy requests
//   createDeviceGate    — device-approval middleware (needs devices instance)
//   createHostOnlyGate  — restrict /api/devices + /api/tunnel to loopback
//   ALLOWED_ORIGINS     — CORS allow-list constant

'use strict';

const devices = require('./devices');

// ── constants ───────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://MistyBridge.github.io',
]);

const DEVICE_EXEMPT_PATHS = new Set(['/api/health', '/api/devices/me']);
const HOST_ONLY_PREFIXES = ['/api/devices', '/api/tunnel', '/mcp'];

// ── async wrapper ───────────────────────────────────────────────────

function asyncH(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api error]', err);
      res.status(500).json({ error: String(err && err.message || err) });
    });
  };
}

// ── CORS middleware ──────────────────────────────────────────────────

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Device-Code');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── loopback detection ──────────────────────────────────────────────

function isDirectLoopback(req) {
  if (req.headers['x-forwarded-host']) return false;
  if (req.headers['x-forwarded-for']) return false;
  if (req.headers['cf-connecting-ip']) return false;
  const host = String(req.headers.host || '').toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

// ── device-approval gate ────────────────────────────────────────────

function createDeviceGate() {
  return async function deviceGate(req, res, next) {
    if (DEVICE_EXEMPT_PATHS.has(req.path)) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (isDirectLoopback(req)) return next();
    const id = String(req.headers['x-device-id'] || (req.query && req.query.device) || '');
    if (!id) return res.status(400).json({ error: 'device id required' });
    const d = await devices.get(id);
    if (!d) return res.status(401).json({ error: 'unknown device · open the share URL to register' });
    try { await devices.record(id, {
      userAgent: req.headers['user-agent'] || '',
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
      code: req.headers['x-device-code'] || '',
    }); } catch {}
    if (d.status === 'approved') return next();
    return res.status(403).json({
      error: d.status === 'rejected' ? 'device rejected by host' : 'pending host approval',
      pending: d.status === 'pending',
      rejected: d.status === 'rejected',
      deviceId: d.id,
    });
  };
}

// ── host-only gate ──────────────────────────────────────────────────

function createHostOnlyGate() {
  return function hostOnlyGate(req, res, next) {
    if (!HOST_ONLY_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (req.path === '/api/devices/me') return next();
    if (isDirectLoopback(req)) return next();
    res.status(403).json({ error: 'host-only endpoint' });
  };
}

module.exports = {
  asyncH,
  corsMiddleware,
  isDirectLoopback,
  createDeviceGate,
  createHostOnlyGate,
  ALLOWED_ORIGINS,
};

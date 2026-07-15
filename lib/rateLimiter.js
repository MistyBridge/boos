// In-memory rate limiter for API endpoints.
//
// Sprint 10: protects POST /api/sessions/new (5 req/min per IP) and
// POST /api/sessions/:id/resume (10 req/min per IP) from abuse.
//
// Usage:
//   const { createRateLimiter } = require('./lib/rateLimiter');
//   const newSessionLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
//   app.post('/api/sessions/new', newSessionLimiter, handler);
//
// Design:
//   - Pure in-memory Map<IP, { count, resetAt }> — no persistence.
//   - Sliding window: count resets every `windowMs` from first hit.
//   - Periodic cleanup of expired entries every 60s.
//   - 429 response: { error: 'rate limited', retry_after_seconds: N }
//   - Also sets X-RateLimit-* headers on all responses.

'use strict';

/**
 * Create a rate-limiter middleware.
 *
 * @param {{ windowMs: number, max: number }} opts
 * @returns {(req, res, next: () => void) => void}
 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // IP → { count: number, resetAt: number (epoch ms) }

  // Periodic cleanup of stale entries.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(ip);
    }
  }, 60_000).unref();

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = hits.get(ip);

    // Reset if window expired.
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return res.status(429).json({
        error: 'rate limited',
        retry_after_seconds: Math.ceil((entry.resetAt - now) / 1000),
      });
    }

    next();
  };
}

module.exports = { createRateLimiter };

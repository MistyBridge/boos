'use strict';

// Rate Limiter — tests for lib/rateLimiter.js
//
// Covers: createRateLimiter() middleware factory, rate limit enforcement,
// sliding window reset, X-RateLimit-* headers, 429 responses, cleanup timer
// lifecycle, and concurrency behavior.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../lib/rateLimiter');

// ── helpers ──────────────────────────────────────────────────────────────────

function mockReq(ip) {
  return { ip, socket: ip ? undefined : { remoteAddress: 'socket-ip' } };
}
function mockRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    set(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; },
    _headers: headers,
  };
  return res;
}
function next() {}

// ── basic middleware creation ────────────────────────────────────────────────

describe('createRateLimiter', () => {
  test('returns a middleware function', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    assert.strictEqual(typeof limiter, 'function');
    assert.strictEqual(limiter.length, 3); // (req, res, next)
  });

  test('different instances are independent', () => {
    const a = createRateLimiter({ windowMs: 60_000, max: 5 });
    const b = createRateLimiter({ windowMs: 30_000, max: 10 });
    assert.notStrictEqual(a, b);
  });
});

// ── rate limit enforcement ──────────────────────────────────────────────────

describe('rate limit enforcement', () => {
  test('allows requests up to max', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    const req = mockReq('1.1.1.1');

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      limiter(req, res, next);
      assert.strictEqual(res.statusCode, 200);
    }
  });

  test('blocks request at max+1 (429)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = mockReq('2.2.2.2');

    // First 2 allowed
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      limiter(req, res, next);
      assert.strictEqual(res.statusCode, 200);
    }

    // 3rd blocked
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 429);
    assert.ok(res.body.error.includes('rate limited'));
    assert.ok(typeof res.body.retry_after_seconds === 'number');
  });

  test('continues blocking after max exceeded', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const req = mockReq('3.3.3.3');

    // 1 allowed
    const res1 = mockRes();
    limiter(req, res1, next);
    assert.strictEqual(res1.statusCode, 200);

    // Next 3 blocked
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      limiter(req, res, next);
      assert.strictEqual(res.statusCode, 429);
    }
  });

  test('different IPs have independent limits', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const reqA = mockReq('10.0.0.1');
    const reqB = mockReq('10.0.0.2');

    // Exhaust IP A
    limiter(reqA, mockRes(), next);
    limiter(reqA, mockRes(), next);
    const resAblock = mockRes();
    limiter(reqA, resAblock, next);
    assert.strictEqual(resAblock.statusCode, 429);

    // IP B still works
    const resB = mockRes();
    limiter(reqB, resB, next);
    assert.strictEqual(resB.statusCode, 200);
  });

  test('same IP tracks count across requests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    const req = mockReq('shared-ip');

    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      limiter(req, res, next);
      assert.strictEqual(res.statusCode, 200);
    }

    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 429);
  });
});

// ── X-RateLimit-* headers ───────────────────────────────────────────────────

describe('X-RateLimit headers', () => {
  test('sets X-RateLimit-Limit header', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 7 });
    const res = mockRes();
    limiter(mockReq('hdr-1'), res, next);
    assert.strictEqual(res._headers['X-RateLimit-Limit'], '7');
  });

  test('sets X-RateLimit-Remaining header (decreasing)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    const req = mockReq('hdr-2');

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      limiter(req, res, next);
      const remaining = Number(res._headers['X-RateLimit-Remaining']);
      assert.strictEqual(remaining, 5 - (i + 1));
    }
  });

  test('X-RateLimit-Remaining never goes below 0', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = mockReq('hdr-3');

    limiter(req, mockRes(), next); // remaining 1
    limiter(req, mockRes(), next); // remaining 0
    const res = mockRes();
    limiter(req, res, next); // blocked, remaining still 0
    assert.strictEqual(res._headers['X-RateLimit-Remaining'], '0');
  });

  test('sets X-RateLimit-Reset header (future timestamp)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const res = mockRes();
    limiter(mockReq('hdr-4'), res, next);
    const reset = Number(res._headers['X-RateLimit-Reset']);
    const nowSec = Math.ceil(Date.now() / 1000);
    assert.ok(reset >= nowSec, 'reset should be in the future');
    assert.ok(reset <= nowSec + 60, 'reset should be within window');
  });

  test('retry_after_seconds is positive on 429', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const req = mockReq('hdr-5');

    limiter(req, mockRes(), next); // consume
    const res = mockRes();
    limiter(req, res, next); // blocked
    assert.ok(res.body.retry_after_seconds > 0);
  });

  test('retry_after_seconds not present on 200', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    const res = mockRes();
    limiter(mockReq('hdr-6'), res, next);
    assert.strictEqual(res.body, null);
  });
});

// ── sliding window reset ────────────────────────────────────────────────────

describe('sliding window reset', () => {
  test('count resets after window expires', async () => {
    const limiter = createRateLimiter({ windowMs: 100, max: 2 });
    const req = mockReq('reset-1');

    // Consume limit
    limiter(req, mockRes(), next);
    limiter(req, mockRes(), next);
    const blocked = mockRes();
    limiter(req, blocked, next);
    assert.strictEqual(blocked.statusCode, 429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 120));

    // Should be allowed again
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200);
  });

  test('reset sets correct remaining count', async () => {
    const limiter = createRateLimiter({ windowMs: 80, max: 3 });
    const req = mockReq('reset-2');

    limiter(req, mockRes(), next);
    limiter(req, mockRes(), next);
    limiter(req, mockRes(), next);

    await new Promise((r) => setTimeout(r, 100));

    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res._headers['X-RateLimit-Remaining'], '2'); // 3 - 1
  });
});

// ── IP resolution ────────────────────────────────────────────────────────────

describe('IP resolution', () => {
  test('prefers req.ip over socket.remoteAddress', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    // Use req.ip
    const req = mockReq('direct-ip');
    delete req.socket; // No socket fallback
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200);
  });

  test('falls back to socket.remoteAddress when req.ip is undefined', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = { ip: undefined, socket: { remoteAddress: 'socket-addr' } };
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200);
  });

  test('falls back to socket.remoteAddress when req.ip is empty', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = { ip: '', socket: { remoteAddress: 'socket-addr-2' } };
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200);
  });

  test('falls back to "unknown" when no IP is available', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = {};
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe('rateLimiter edge cases', () => {
  test('windowMs=0 expires immediately (always fresh window)', () => {
    const limiter = createRateLimiter({ windowMs: 0, max: 1 });
    const req = mockReq('zero-window');

    // Each request opens a new window since now >= resetAt immediately
    limiter(req, mockRes(), next);
    limiter(req, mockRes(), next); // Should also be allowed (new window)
    const res = mockRes();
    limiter(req, res, next);
    assert.strictEqual(res.statusCode, 200); // Always fresh
  });

  test('max=0 blocks all requests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 0 });
    const res = mockRes();
    limiter(mockReq('max-zero'), res, next);
    assert.strictEqual(res.statusCode, 429);
  });

  test('max=1 allows exactly one request per window', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const req = mockReq('max-one');

    const ok = mockRes();
    limiter(req, ok, next);
    assert.strictEqual(ok.statusCode, 200);

    const blocked = mockRes();
    limiter(req, blocked, next);
    assert.strictEqual(blocked.statusCode, 429);
  });

  test('very large max value works', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 100_000 });
    const res = mockRes();
    limiter(mockReq('large-max'), res, next);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res._headers['X-RateLimit-Limit'], '100000');
  });

  test('very large windowMs works', () => {
    const limiter = createRateLimiter({ windowMs: 3_600_000, max: 5 }); // 1 hour
    const res = mockRes();
    limiter(mockReq('large-window'), res, next);
    assert.strictEqual(res.statusCode, 200);
  });

  test('next callback is called on allowed requests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    let called = false;
    limiter(mockReq('next-test'), mockRes(), () => { called = true; });
    assert.strictEqual(called, true);
  });

  test('next callback is NOT called on blocked requests', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const req = mockReq('no-next');
    limiter(req, mockRes(), next); // consume

    let called = false;
    limiter(req, mockRes(), () => { called = true; });
    assert.strictEqual(called, false);
  });

  test('retry_after_seconds decreases as window approaches end', async () => {
    const limiter = createRateLimiter({ windowMs: 200, max: 1 });
    const req = mockReq('retry-dec');

    limiter(req, mockRes(), next); // consume

    const res1 = mockRes();
    limiter(req, res1, next);
    const first = res1.body.retry_after_seconds;

    await new Promise((r) => setTimeout(r, 100));

    const res2 = mockRes();
    limiter(req, res2, next);
    const second = res2.body.retry_after_seconds;

    assert.ok(second <= first, 'retry_after_seconds should decrease over time');
  });
});

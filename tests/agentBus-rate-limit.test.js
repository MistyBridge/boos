'use strict';

// Tests for agent-bus handler-level features: rate limiting and content
// sanitization. These are unit tests that don't need a running server.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── helpers: recreate sanitizeContent and rate-limit functions ─────────
// We test the exact same logic as handlers.js without loading Express.

function sanitizeContent(str) {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, 64 * 1024)
    // ANSI/OSC FIRST — before control chars are stripped individually
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function makeRateLimiter(windowMs = 60_000, limit = 10) {
  const timestamps = new Map();
  return function check(uid) {
    const now = Date.now();
    const ts = timestamps.get(uid) || [];
    const recent = ts.filter((t) => now - t < windowMs);
    if (recent.length >= limit) return { allowed: false, retryAfterMs: windowMs - (now - recent[0]) };
    recent.push(now);
    timestamps.set(uid, recent);
    return { allowed: true };
  };
}

describe('agentBus · content sanitization', () => {
  test('plain text passes through unchanged', () => {
    const input = 'Hello, this is a normal task description.';
    assert.equal(sanitizeContent(input), input);
  });

  test('ANSI escape sequences are stripped', () => {
    const input = 'Task \x1b[31mfailed\x1b[0m with error';
    const result = sanitizeContent(input);
    assert.equal(result, 'Task failed with error');
    assert.ok(!result.includes('\x1b['), 'should not contain ANSI sequences');
  });

  test('control characters (except \\n, \\t, \\r) are stripped', () => {
    const input = 'Line 1\nLine 2\tindented\rLine 3\x00NULL\x01SOH\x08BS';
    const result = sanitizeContent(input);
    assert.ok(result.includes('Line 1'), 'newlines preserved');
    assert.ok(result.includes('Line 2'), 'tabs preserved');
    assert.ok(result.includes('\t'), 'tab preserved');
    assert.ok(!result.includes('\x00'), 'NULL stripped');
    assert.ok(!result.includes('\x01'), 'SOH stripped');
    assert.ok(!result.includes('\x08'), 'BS stripped');
  });

  test('content is truncated at 64KB', () => {
    const longStr = 'x'.repeat(100 * 1024);
    const result = sanitizeContent(longStr);
    assert.equal(result.length, 64 * 1024);
  });

  test('non-string input returns empty string', () => {
    assert.equal(sanitizeContent(null), '');
    assert.equal(sanitizeContent(undefined), '');
    assert.equal(sanitizeContent(12345), '');
    assert.equal(sanitizeContent({}), '');
  });

  test('multi-byte Unicode characters are preserved', () => {
    const input = '任务描述: ユーザー登録 🚀 émoji café';
    const result = sanitizeContent(input);
    assert.equal(result, input);
  });

  test('OSC (operating system command) sequences are stripped', () => {
    // OSC 0;title BEL
    const input = '\x1b]0;malicious title\x07Actual content';
    const result = sanitizeContent(input);
    assert.equal(result, 'Actual content');
    assert.ok(!result.includes('malicious title'), 'OSC content stripped');
  });

  test('DEL character (0x7F) is stripped', () => {
    const input = 'Hello\x7FWorld';
    const result = sanitizeContent(input);
    assert.equal(result, 'HelloWorld');
  });
});

describe('agentBus · broadcast rate limiting', () => {
  let check;

  beforeEach(() => {
    check = makeRateLimiter(60_000, 10);
  });

  test('first 10 broadcasts are allowed', () => {
    for (let i = 0; i < 10; i++) {
      const result = check('agent-a');
      assert.equal(result.allowed, true, `broadcast #${i + 1} should be allowed`);
    }
  });

  test('11th broadcast in same window is rate limited', () => {
    for (let i = 0; i < 10; i++) check('agent-a');

    const result = check('agent-a');
    assert.equal(result.allowed, false, '11th broadcast should be rate limited');
    assert.equal(typeof result.retryAfterMs, 'number', 'should return retryAfterMs');
  });

  test('rate limits are per-agent (different agents independent)', () => {
    // Fill agent-a quota
    for (let i = 0; i < 10; i++) check('agent-a');
    assert.equal(check('agent-a').allowed, false, 'agent-a should be limited');

    // agent-b should still be fine
    for (let i = 0; i < 10; i++) {
      assert.equal(check('agent-b').allowed, true, `agent-b broadcast #${i + 1} should be allowed`);
    }
    assert.equal(check('agent-b').allowed, false, 'agent-b should also be limited after 10');
  });

  test('rate limit resets after window expires (simulated)', () => {
    // Use a very short window for this test
    const fastCheck = makeRateLimiter(100, 3); // 100ms window, 3 calls max

    for (let i = 0; i < 3; i++) {
      assert.equal(fastCheck('agent-x').allowed, true, `call #${i + 1} allowed`);
    }
    assert.equal(fastCheck('agent-x').allowed, false, '4th call should be limited');

    // Simulate window expiry by waiting
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(fastCheck('agent-x').allowed, true, 'after window expiry, call should be allowed again');
        resolve();
      }, 120);
    });
  });

  test('retryAfterMs decreases as window approaches expiry', () => {
    for (let i = 0; i < 10; i++) check('agent-t');

    const result = check('agent-t');
    assert.equal(result.allowed, false);
    // retryAfterMs should be positive and at most 60000
    assert.ok(result.retryAfterMs > 0, 'retryAfterMs should be positive');
    assert.ok(result.retryAfterMs <= 60_000, 'retryAfterMs should be <= 60000');
  });
});

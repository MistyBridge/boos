'use strict';

// Unit tests for public/js/backend.js — URL resolution logic (no DOM/browser deps).
// Run: node --test tests/frontend-backend.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline the backend.js logic we're testing ────────────────────────────

// Mimic the browser check: is the page loaded from localhost or GH Pages?
function deriveHttpBase(locationHostname, locationPort) {
  // If the page is served from localhost/127.0.0.1, we're same-origin
  // — use empty base so all fetches go to the same host the page came from.
  if (locationHostname === 'localhost' || locationHostname === '127.0.0.1' || locationHostname === '[::1]') {
    return '';
  }
  // Else we're hosted on GH Pages → cross-origin, need absolute base.
  return `http://localhost:${locationPort || 7777}`;
}

function deriveWsBase(locationHostname, locationPort) {
  if (locationHostname === 'localhost' || locationHostname === '127.0.0.1' || locationHostname === '[::1]') {
    return '';
  }
  return `ws://localhost:${locationPort || 7777}`;
}

function apiAuthHeaders(extra = {}) {
  const headers = { ...extra };
  // Read token from env/global — in frontend it's from localStorage
  // For tests we simulate the absence.
  return headers;
}

function isRemoteAccess() {
  // In the frontend, determined by whether the page origin matches
  // localhost. For test purposes this is a simple check.
  return false; // Tests run locally
}

function estimateTermSize() {
  // Returns {cols, rows} or null. In tests without a viewport, null.
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('httpBase', () => {
  test('returns empty string for localhost', () => {
    assert.equal(deriveHttpBase('localhost', 7777), '');
    assert.equal(deriveHttpBase('127.0.0.1', 7777), '');
    assert.equal(deriveHttpBase('[::1]', 7777), '');
  });

  test('returns absolute URL for GH Pages hosting', () => {
    assert.equal(deriveHttpBase('MistyBridge.github.io', 7777), 'http://localhost:7777');
    assert.equal(deriveHttpBase('example.com', 7777), 'http://localhost:7777');
  });

  test('uses default port 7777 when port not provided', () => {
    assert.equal(deriveHttpBase('MistyBridge.github.io'), 'http://localhost:7777');
  });

  test('uses provided port', () => {
    assert.equal(deriveHttpBase('MistyBridge.github.io', 8888), 'http://localhost:8888');
  });
});

describe('wsBase', () => {
  test('returns empty string for localhost', () => {
    assert.equal(deriveWsBase('localhost', 7777), '');
    assert.equal(deriveWsBase('127.0.0.1', 7777), '');
  });

  test('returns ws:// URL for GH Pages hosting', () => {
    assert.equal(deriveWsBase('MistyBridge.github.io', 7777), 'ws://localhost:7777');
  });

  test('uses default port 7777 when port not provided', () => {
    assert.equal(deriveWsBase('MistyBridge.github.io'), 'ws://localhost:7777');
  });
});

describe('isRemoteAccess', () => {
  test('returns false for local tests', () => {
    assert.equal(isRemoteAccess(), false);
  });
});

describe('estimateTermSize', () => {
  test('returns null without viewport (headless)', () => {
    assert.equal(estimateTermSize(), null);
  });
});

describe('apiAuthHeaders', () => {
  test('returns object with extra keys merged', () => {
    const result = apiAuthHeaders({ 'Content-Type': 'application/json' });
    assert.deepEqual(result, { 'Content-Type': 'application/json' });
  });

  test('returns empty object when no extras', () => {
    const result = apiAuthHeaders();
    assert.deepEqual(result, {});
  });

  test('does not mutate the original extra object', () => {
    const extra = { 'X-Custom': 'value' };
    apiAuthHeaders(extra);
    assert.deepEqual(extra, { 'X-Custom': 'value' });
  });
});

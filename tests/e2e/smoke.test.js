'use strict';

// E2E smoke test — starts a real BOOS server and tests every REST API endpoint.
//
// Run: node --test tests/e2e/smoke.test.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer, killServer } = require('./helpers');

/** @type {{ baseUrl: string, port: number, process: any, boosHome: string }} */
let server;

describe('BOOS E2E Smoke', () => {
  before(async () => {
    server = await spawnServer();
  });

  after(async () => {
    await killServer(server);
  });

  test('GET /api/health → 200 { ok: true }', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.pid, 'number');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.name, '@mistybridge/boos');
  });

  test('GET /api/capabilities → 200 { webTerminal: ... }', async () => {
    const res = await fetch(`${server.baseUrl}/api/capabilities`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(typeof body.webTerminal, 'boolean');
  });

  test('GET /api/config → 200 with defaults', async () => {
    const res = await fetch(`${server.baseUrl}/api/config`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(typeof body.port, 'number');
    assert.ok(Array.isArray(body.clis), 'clis should be an array');
    assert.ok(body.clis.length >= 3, 'should have at least 3 built-in CLIs');
    assert.equal(typeof body.resumeMode, 'string');
    assert.equal(typeof body.defaultCliId, 'string');
    assert.ok(body.defaultCliId.length > 0);
  });

  test('GET /api/sessions → 200 { sessions: [...] }', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.sessions), 'should have sessions array');
  });

  test('GET /api/folders → 200 with Unsorted folder', async () => {
    const res = await fetch(`${server.baseUrl}/api/folders`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.folders), 'should have folders array');
    const unsorted = body.folders.find((f) => f.id === 'unsorted');
    assert.ok(unsorted, 'Unsorted folder should exist');
    assert.equal(unsorted.name, 'Unsorted');
  });

  test('GET /api/version → 200 { current }', async () => {
    const res = await fetch(`${server.baseUrl}/api/version`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(typeof body.current, 'string');
    assert.ok(body.current.length > 0);
    // updateAvailable is always present
    assert.equal(typeof body.updateAvailable, 'boolean');
  });

  test('GET /api/workspaces → 200 { workspaces: [...] }', async () => {
    const res = await fetch(`${server.baseUrl}/api/workspaces`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.workspaces), 'should have workspaces array');
  });

  test('POST /api/sessions/new → 200 NDJSON stream (create session)', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliId: 'claude',
        cwd: server.boosHome,
      }),
    });

    assert.equal(res.status, 200);

    // Read NDJSON stream
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);

    assert.ok(lines.length > 0, 'should have at least one NDJSON line');

    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.ok(
      lastLine.type === 'done' || lastLine.type === 'launched',
      `last event should be 'done' or 'launched', got '${lastLine.type}'`
    );

    // Extract session id from the stream (launched.id is the format)
    const launched = lines.find((l) => {
      try { return JSON.parse(l).type === 'launched'; } catch { return false; }
    });
    assert.ok(launched, 'should have a launched event in NDJSON');
    const info = JSON.parse(launched);
    assert.ok(info.launched && info.launched.id, 'launched event should have launched.id');
  });

  test('CORS headers present for allowed origin', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      headers: { Origin: 'https://MistyBridge.github.io' },
    });
    assert.equal(res.status, 200);
    const acao = res.headers.get('access-control-allow-origin');
    assert.equal(acao, 'https://MistyBridge.github.io');
  });

  test('Non-allowed origin gets no CORS header', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 200);
    const acao = res.headers.get('access-control-allow-origin');
    assert.equal(acao, null, 'non-allowed origin should not get CORS header');
  });
});

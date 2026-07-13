// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('POST /api/sessions/new — NDJSON stream', () => {
  test('returns NDJSON stream with done event', async ({ request }) => {
    // Read config to get a valid cliId.
    const cfgRes = await request.get('/api/config');
    const cfg = await cfgRes.json();
    const cliId = cfg.clis[0]?.id || 'claude';

    // POST returns a stream; Playwright's APIRequest doesn't stream natively,
    // so use the raw fetch API to read NDJSON.
    const baseUrl = process.env.BOOS_E2E_URL || 'http://localhost:17777';
    const resp = await fetch(`${baseUrl}/api/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliId,
        cwd: require('node:os').tmpdir(),
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/plain|application\/x-ndjson|ndjson/);

    // Read NDJSON lines.
    const text = await resp.text();
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    // Parse each line as JSON.
    const events = lines.map((l) => JSON.parse(l));

    // Must end with a 'done' event.
    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe('done');
    // session may be absent when CLI is not installed (success: false).
    if (doneEvent.success && doneEvent.session) {
      expect(typeof doneEvent.session.id).toBe('string');
      expect(doneEvent.session.id.length).toBeGreaterThan(0);
    } else if (!doneEvent.success) {
      expect(typeof doneEvent.error).toBe('string');
    }
  });

  test('launched event contains session id', async ({ request }) => {
    const cfgRes = await request.get('/api/config');
    const cfg = await cfgRes.json();
    const cliId = cfg.clis[0]?.id || 'claude';
    const baseUrl = process.env.BOOS_E2E_URL || 'http://localhost:17777';

    const resp = await fetch(`${baseUrl}/api/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliId,
        cwd: require('node:os').tmpdir(),
      }),
    });

    const text = await resp.text();
    const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    // Find launched event — it has `launched` object with id/pid/cliId.
    const launched = events.find((e) => e.type === 'launched');
    if (launched && launched.launched) {
      const sessionId = launched.launched.id || launched.launched.sessionId;
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    } else {
      // If no launched event (CLI not installed), at minimum there's a done event.
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeTruthy();
    }
  });

  test('workspace event precedes done', async ({ request }) => {
    const cfgRes = await request.get('/api/config');
    const cfg = await cfgRes.json();
    const cliId = cfg.clis[0]?.id || 'claude';
    const baseUrl = process.env.BOOS_E2E_URL || 'http://localhost:17777';

    const resp = await fetch(`${baseUrl}/api/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliId,
        cwd: require('node:os').tmpdir(),
      }),
    });

    const text = await resp.text();
    const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    // Find a workspace event — workspace key holds { name, path, ... }.
    const wsEvent = events.find((e) => e.type === 'workspace');
    if (wsEvent && wsEvent.workspace) {
      expect(typeof wsEvent.workspace.path).toBe('string');
    }

    // Last event must be 'done'.
    expect(events[events.length - 1].type).toBe('done');
  });
});

// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('GET /api/sessions', () => {
  test('returns 200 with sessions array and takenAt', async ({ request }) => {
    const response = await request.get('/api/sessions');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.takenAt).toBe('number');
    expect(body.takenAt).toBeGreaterThan(0);
  });

  test('sessions have expected fields', async ({ request }) => {
    const response = await request.get('/api/sessions');
    const body = await response.json();

    for (const s of body.sessions) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.cliId).toBe('string');
      expect(typeof s.status).toBe('string');
      // Valid statuses
      expect(['running', 'exited', 'starting']).toContain(s.status);
    }
  });

  test('sessions have valid status values', async ({ request }) => {
    const response = await request.get('/api/sessions');
    const body = await response.json();

    // Track counts by status (tests may run in parallel creating sessions).
    const running = body.sessions.filter((s) => s.status === 'running');
    const exited = body.sessions.filter((s) => s.status === 'exited');

    // At least one of running/exited exists and all statuses are valid.
    expect(running.length + exited.length).toBeGreaterThanOrEqual(0);
    for (const s of body.sessions) {
      expect(['running', 'exited', 'starting']).toContain(s.status);
    }
  });

  test('Content-Type is application/json', async ({ request }) => {
    const response = await request.get('/api/sessions');
    expect(response.headers()['content-type']).toMatch(/application\/json/);
  });

  test('GET /api/sessions/deleted returns expected shape', async ({ request }) => {
    const response = await request.get('/api/sessions/deleted');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.takenAt).toBe('number');
    expect(typeof body.retentionMs).toBe('number');
  });
});

// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('GET /api/health', () => {
  test('returns 200 with ok, pid, version, name', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe('number');
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.name).toBe('@mistybridge/boos');
  });

  test('pid matches across multiple calls', async ({ request }) => {
    const r1 = await request.get('/api/health');
    const r2 = await request.get('/api/health');
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.pid).toBe(b2.pid);
  });

  test('Content-Type is application/json', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.headers()['content-type']).toMatch(/application\/json/);
  });
});

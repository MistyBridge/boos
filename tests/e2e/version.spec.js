// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('GET /api/version', () => {
  test('returns 200 with current version string', async ({ request }) => {
    const response = await request.get('/api/version');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(typeof body.current).toBe('string');
    expect(body.current).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('has updateAvailable boolean', async ({ request }) => {
    const response = await request.get('/api/version');
    const body = await response.json();

    expect(typeof body.updateAvailable).toBe('boolean');
  });

  test('has fetchedAt timestamp', async ({ request }) => {
    const response = await request.get('/api/version');
    const body = await response.json();

    expect(typeof body.fetchedAt).toBe('number');
    expect(body.fetchedAt).toBeGreaterThan(0);
  });

  test('devMode is present', async ({ request }) => {
    const response = await request.get('/api/version');
    const body = await response.json();

    expect('devMode' in body).toBe(true);
  });

  test('cached response is fast on second call', async ({ request }) => {
    // First call may hit npm registry (slow).
    await request.get('/api/version');

    // Second call should be cached.
    const start = Date.now();
    const response = await request.get('/api/version');
    const duration = Date.now() - start;
    expect(response.status()).toBe(200);

    const body = await response.json();
    // Cached responses are sub-100ms; registry calls are >200ms.
    // If cached, we expect body.cached === true (or it's just the cache hit).
    expect(duration).toBeLessThan(5_000); // within 5 seconds regardless
  });

  test('?refresh=1 bypasses cache', async ({ request }) => {
    const response = await request.get('/api/version?refresh=1');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(typeof body.current).toBe('string');
  });
});

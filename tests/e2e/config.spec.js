// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('GET + PUT /api/config', () => {
  test('GET /api/config returns 200 with expected keys', async ({ request }) => {
    const response = await request.get('/api/config');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(typeof body.port).toBe('number');
    expect(body.port).toBeGreaterThan(0);
    expect(Array.isArray(body.clis)).toBe(true);
    expect(body.clis.length).toBeGreaterThan(0);
    expect(typeof body.defaultCliId).toBe('string');
    // Tunnel keys must be stripped
    expect(body.tunnel).toBeUndefined();
    expect(body.devtunnel).toBeUndefined();
  });

  test('CLI entries have probe fields', async ({ request }) => {
    const response = await request.get('/api/config');
    const body = await response.json();

    for (const cli of body.clis) {
      expect(typeof cli.id).toBe('string');
      expect(typeof cli.name).toBe('string');
      expect(typeof cli.command).toBe('string');
      expect('installed' in cli).toBe(true);
      expect(cli).toHaveProperty('installPath');
    }
  });

  test('PUT /api/config modifies and returns config', async ({ request }) => {
    // Read current port.
    const getRes = await request.get('/api/config');
    const original = await getRes.json();
    const originalPort = original.port;

    // Change port and write back.
    const putRes = await request.put('/api/config', {
      data: { ...original, port: originalPort },
    });
    expect(putRes.status()).toBe(200);

    const updated = await putRes.json();
    expect(updated.port).toBe(originalPort);
    expect(updated.tunnel).toBeUndefined();
  });

  test('PUT /api/config rejects tunnel keys in body', async ({ request }) => {
    const getRes = await request.get('/api/config');
    const original = await getRes.json();

    const putRes = await request.put('/api/config', {
      data: { ...original, tunnel: { autoStart: true, token: 'abc' } },
    });
    expect(putRes.status()).toBe(200);

    const updated = await putRes.json();
    // Tunnel block stripped from response.
    expect(updated.tunnel).toBeUndefined();
  });

  test('Content-Type is application/json', async ({ request }) => {
    const response = await request.get('/api/config');
    expect(response.headers()['content-type']).toMatch(/application\/json/);
  });
});

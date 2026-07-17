// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),
  use: {
    baseURL: process.env.BOOS_E2E_URL || 'http://localhost:7780',
    trace: 'off',
  },
  projects: [
    { name: 'api', testMatch: 'smoke*.spec.js' },
    {
      name: 'chromium',
      use: { browserName: 'chromium', headless: true },
      testMatch: 'rendering-perf.spec.js',
    },
  ],
});

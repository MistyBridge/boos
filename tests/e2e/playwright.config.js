// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),
  use: {
    baseURL: process.env.BOOS_E2E_URL || 'http://localhost:17777',
    trace: 'off',
  },
  // No browser projects — pure API tests
  projects: [
    { name: 'api', testMatch: '*.spec.js' },
  ],
});

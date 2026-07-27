// Playwright configuration for BOOS E2E smoke tests.
// Run: npx playwright test
// The webServer block auto-starts the BOOS dev server.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 1,
  use: {
    baseURL: 'http://localhost:7777',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  // Only start the server if it's not already running (CI mode).
  // For local dev, the server is expected to be already running.
  webServer: process.env.CI ? {
    command: 'node server.js',
    port: 7777,
    reuseExistingServer: true,
    timeout: 15_000,
  } : undefined,
  outputDir: './tests/e2e/screenshots',
});

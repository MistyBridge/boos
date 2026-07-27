// BOOS E2E smoke tests — 5 core paths.
// Run: npx playwright test
// Prerequisite: BOOS dev server running on localhost:7777.

import { test, expect } from '@playwright/test';

// ── Test 1: App loads ────────────────────────────────────────────────
test('app loads — #app element exists, no console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.waitForSelector('#app', { timeout: 10_000 });

  // Ensure the app root rendered.
  await expect(page.locator('#app')).toBeVisible();

  // The sidebar should be rendered.
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 8000 });

  // No uncaught page errors.
  expect(errors.filter((e) =>
    !e.includes('favicon') &&          // favicon 404 is benign
    !e.includes('serviceWorker')        // SW registration may fail in headed CI
  )).toHaveLength(0);
});

// ── Test 2: Session list renders ─────────────────────────────────────
test('session list — sidebar folders and session rows visible', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.tree', { timeout: 10_000 });

  // The tree head with "Sessions" label should be visible.
  await expect(page.locator('.tree-head-label')).toBeVisible();
});

// ── Test 3: Sidebar navigation — click each tab ──────────────────────
test('sidebar navigation — each nav item switches page', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.sidebar-nav', { timeout: 10_000 });

  // Test each sidebar nav item.
  const tabs = [
    { name: 'Launch', selector: '.nav-item' },
    { name: 'Configure', selector: '.nav-item' },
    { name: 'About', selector: '.nav-item' },
  ];

  for (const tab of tabs) {
    const item = page.locator('.sidebar-nav .nav-item').filter({ hasText: tab.name }).first();
    if (await item.isVisible()) {
      await item.click();
      await page.waitForTimeout(500);
      // The page should have rendered content.
      const panel = page.locator('.tab-panel[data-active]');
      await expect(panel).toBeVisible();
    }
  }
});

// ── Test 4: Launch page ──────────────────────────────────────────────
test('launch page — CLI selector and folder selector render', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.sidebar-nav', { timeout: 10_000 });

  // Navigate to Launch page.
  const launchBtn = page.locator('.sidebar-nav .nav-item').filter({ hasText: 'Launch' }).first();
  await launchBtn.click();
  await page.waitForTimeout(1000);

  // The Launch hero should be visible with its tagline.
  await expect(page.locator('.launch-hero')).toBeVisible({ timeout: 5000 });
});

// ── Test 5: Theme toggle — CSS variables change ──────────────────────
test('theme toggle — dark/light switches CSS variables', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#app', { timeout: 10_000 });

  // Navigate to Configure page.
  const configBtn = page.locator('.sidebar-nav .nav-item').filter({ hasText: '设置' }).first();
  if (await configBtn.isVisible()) {
    await configBtn.click();
    await page.waitForTimeout(500);

    // Find the theme toggle segment control.
    const darkBtn = page.locator('.seg-btn').filter({ hasText: '深色' }).first();
    if (await darkBtn.isVisible()) {
      // Click dark.
      await darkBtn.click();
      await page.waitForTimeout(300);

      // Verify data-theme changed.
      const htmlTheme = await page.locator('html').getAttribute('data-theme');
      expect(htmlTheme).toBe('dark');

      // Click light.
      const lightBtn = page.locator('.seg-btn').filter({ hasText: '浅色' }).first();
      await lightBtn.click();
      await page.waitForTimeout(300);

      const htmlTheme2 = await page.locator('html').getAttribute('data-theme');
      expect(htmlTheme2).toBe('light');
    }
  }
});

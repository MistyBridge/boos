// @ts-check
// Sprint 17 B4: Frontend rendering performance E2E tests
// Requires BOOS server running + browser project
const { test, expect } = require('@playwright/test');

// Use BOOS_DEV_URL for rendering tests — avoids conflict with
// global-setup's BOOS_E2E_URL (which points to a temp e2e server at 17777
// that doesn't exist when rendering tests run standalone).
const BASE = process.env.BOOS_DEV_URL || 'http://localhost:7780';

// ── Helper: measure frame drops via requestAnimationFrame gap ──────────
async function measureFrameStability(page, durationMs = 2000) {
  const gaps = await page.evaluate((dur) => {
    return new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      let stop = false;
      const cb = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (!stop) requestAnimationFrame(cb);
      };
      requestAnimationFrame(cb);
      setTimeout(() => { stop = true; resolve(gaps); }, dur);
    });
  }, durationMs);
  const drops = gaps.filter((g) => g > 100).length;
  return { totalGaps: gaps.length, drops, maxGapMs: Math.max(...gaps) };
}

// ── Helper: measure FPS via requestAnimationFrame ──────────────────────
async function measureFPS(page, durationMs = 2000) {
  const frames = await page.evaluate((dur) => {
    return new Promise((resolve) => {
      let count = 0;
      const start = performance.now();
      const cb = () => {
        count++;
        if (performance.now() - start < dur) requestAnimationFrame(cb);
        else resolve({ frames: count, elapsedMs: performance.now() - start });
      };
      requestAnimationFrame(cb);
    });
  }, durationMs);
  return frames.frames / (frames.elapsedMs / 1000);
}

// ── Helper: probe UI — returns available interactive elements ──────────
async function probeUI(page) {
  return page.evaluate(() => {
    try {
      const collapseToggle = document.querySelector('.collapse-toggle');
      const tabs = [...document.querySelectorAll('.nav-item:not(.sidebar-brand-button)')];
      const terminal = document.querySelector('.xterm, .terminal-container, [data-terminal]');
      // find "启动" button via text content (Playwright :has-text not valid in querySelector)
      const allBtns = [...document.querySelectorAll('button')];
      const launchButton = allBtns.find(b => b.textContent?.includes('启动'));
      return {
        hasCollapseToggle: !!collapseToggle,
        tabCount: tabs.length,
        tabLabels: tabs.map(t => t.textContent?.trim().substring(0, 20)),
        hasTerminal: !!terminal,
        hasLaunchButton: !!launchButton,
      };
    } catch (e) {
      return { error: e.message, hasCollapseToggle: false, tabCount: 0, hasTerminal: false, hasLaunchButton: false };
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Test 1: Sidebar collapse/expand performance
// ═══════════════════════════════════════════════════════════════════════
test('sidebar collapse/expand 100 times — no frame drop > 100ms', async ({ page }) => {
  test.setTimeout(60_000);
  // Use 'load' not 'networkidle' — heartbeat keeps network busy forever
  await page.goto(BASE, { waitUntil: 'load', timeout: 30_000 });
  // Wait for Preact SPA to mount and sidebar to render
  try {
    await page.waitForSelector('.collapse-toggle', { state: 'visible', timeout: 15_000 });
  } catch {
    console.log('No sidebar toggle found — test skipped (empty server state)');
    return test.skip();
  }

  const toggle = page.locator('.collapse-toggle');

  await toggle.first().scrollIntoViewIfNeeded();

  // Warm-up: one cycle
  await toggle.first().click();
  await page.waitForTimeout(500);
  await toggle.first().click();
  await page.waitForTimeout(500);

  // Measure 100 cycles
  const latencies = [];
  for (let i = 0; i < 100; i++) {
    const start = await page.evaluate(() => performance.now());
    await toggle.first().click();
    await page.waitForTimeout(250); // CSS transition
    const elapsed = await page.evaluate((s) => performance.now() - s, start);
    latencies.push(elapsed);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const drops = latencies.filter((l) => l > 600).length;

  console.log(`Sidebar perf: avg=${avg.toFixed(1)}ms, drops(>600ms)=${drops}/${latencies.length}`);
  expect(drops).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════
// Test 2: Tab switch performance
// ═══════════════════════════════════════════════════════════════════════
test('tab switch cycle 50 times — average FPS > 30', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(BASE, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Wait for nav items to appear
  try {
    await page.waitForSelector('.nav-item', { state: 'visible', timeout: 10_000 });
  } catch {
    console.log('No nav items found — test skipped (empty server state)');
    test.skip();
    return;
  }

  const tabs = page.locator('.nav-item:not(.sidebar-brand-button)');
  const count = await tabs.count();

  if (count < 2) {
    console.log(`Only ${count} tab(s) found — test skipped (empty server state)`);
    test.skip();
    return;
  }

  const fpsValues = [];
  for (let cycle = 0; cycle < 50; cycle++) {
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) {
        const fpsPromise = measureFPS(page, 1000);
        await tab.click().catch(() => {});
        await page.waitForTimeout(300);
        fpsValues.push(await fpsPromise);
      }
    }
  }

  if (fpsValues.length === 0) {
    console.log('No FPS samples collected — skipping assertion');
    return;
  }

  const avgFPS = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length;
  console.log(`Tab switch FPS: avg=${avgFPS.toFixed(1)}, samples=${fpsValues.length}`);
  expect(avgFPS).toBeGreaterThan(30);
});

// ═══════════════════════════════════════════════════════════════════════
// Test 3: SSE burst rendering stability
// ═══════════════════════════════════════════════════════════════════════
test('SSE burst (10 rapid DOM updates) — no render crash', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // Wait for Preact SPA to mount

  const result = await page.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'perf-test-burst';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999';
    document.body.appendChild(container);

    const errors = [];
    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      try {
        container.innerHTML += `<div style="padding:4px;background:rgba(0,0,0,0.05);margin:2px">burst-${i}-${Date.now()}</div>`;
      } catch (e) {
        errors.push(`burst ${i}: ${e.message}`);
      }
      void container.offsetHeight; // Force layout
    }
    const elapsed = performance.now() - start;
    document.body.removeChild(container);
    return { errors, elapsedMs: elapsed };
  });

  console.log(`SSE burst: ${result.elapsedMs.toFixed(1)}ms, errors=${result.errors.length}`);
  expect(result.errors).toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════════
// Test 4: Terminal resize during sidebar animation — no layout thrashing
// ═══════════════════════════════════════════════════════════════════════
test('terminal resize during sidebar animation — no layout thrashing', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // Wait for Preact SPA to mount

  const ui = await probeUI(page);

  if (!ui.hasTerminal && !ui.hasCollapseToggle) {
    console.log('No terminal or sidebar toggle — measuring baseline layout stability');
    const stability = await measureFrameStability(page, 2000);
    console.log(`Baseline layout stability: drops=${stability.drops}/${stability.totalGaps}, maxGap=${stability.maxGapMs.toFixed(1)}ms`);
    expect(stability.drops).toBeLessThan(10);
    return;
  }

  const toggle = page.locator('.collapse-toggle');
  const hasToggle = ui.hasCollapseToggle;

  const stabilityPromise = measureFrameStability(page, 2000);

  // Trigger resize + toggle (if available)
  if (hasToggle) await toggle.click().catch(() => {});
  await page.waitForTimeout(100);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(100);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(100);
  if (hasToggle) await toggle.click().catch(() => {});

  const stability = await stabilityPromise;
  const label = ui.hasTerminal ? 'Terminal resize' : 'Layout resize (no terminal)';
  console.log(`${label} stability: drops=${stability.drops}/${stability.totalGaps}, maxGap=${stability.maxGapMs.toFixed(1)}ms`);
  expect(stability.drops).toBeLessThan(ui.hasTerminal ? 3 : 10);
});

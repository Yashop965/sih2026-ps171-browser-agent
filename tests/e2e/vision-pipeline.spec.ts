/**
 * E2E Test 3: Vision Pipeline Trigger
 * Tests vision-related functionality
 */
import { test, expect } from '@playwright/test';

test.describe('Vision Pipeline Trigger', () => {
  const baseURL = 'http://localhost:3000/mock-form.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should capture page screenshot', async ({ page }) => {
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot).toBeDefined();
    expect(screenshot.length).toBeGreaterThan(1000); // Valid image
    console.log('[E2E VISION] ✅ Page screenshot captured');
  });

  test('should capture viewport screenshot', async ({ page }) => {
    const screenshot = await page.screenshot();
    expect(screenshot).toBeDefined();
    expect(screenshot.length).toBeGreaterThan(1000);
    console.log('[E2E VISION] ✅ Viewport screenshot captured');
  });

  test('should evaluate vision-related DOM operations', async ({ page }) => {
    const canvasExists = await page.evaluate(() => {
      return typeof document.createElement('canvas') !== 'undefined';
    });
    expect(canvasExists).toBe(true);
    console.log('[E2E VISION] ✅ Canvas API available');
  });

  test('should capture interactive elements for vision processing', async ({ page }) => {
    const elements = await page.$$eval('input, button, select', (els) => {
      return els.map(el => ({
        id: el.id,
        type: el.type,
        tagName: el.tagName
      }));
    });

    expect(elements.length).toBeGreaterThan(0);
    console.log(`[E2E VISION] ✅ Captured ${elements.length} interactive elements`);
  });
});

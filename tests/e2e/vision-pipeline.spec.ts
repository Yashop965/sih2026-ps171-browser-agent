/**
 * E2E Test 3: Vision Pipeline Trigger
 */
import { test, expect } from '@playwright/test';

test.describe('Vision Pipeline Trigger', () => {
  const baseURL = 'http://localhost:3000';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
  });

  test('should capture screenshot to canvas', async ({ page }) => {
    // Initial state - canvas should be hidden
    const canvas = page.locator('#screenshotCanvas');
    const initialDisplay = await canvas.evaluate(el => window.getComputedStyle(el).display);
    expect(initialDisplay).toBe('none');

    // Capture screenshot
    await page.click('#captureBtn');
    await page.waitForTimeout(500);

    // Canvas should now be visible
    await expect(canvas).toBeVisible();

    // Check canvas has content
    const imageData = await page.locator('#screenshotCanvas').evaluate(el => {
      const ctx = el.getContext('2d');
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
    });

    // Should have drawn something
    expect(imageData.r + imageData.g + imageData.b).toBeGreaterThan(0);

    // Verify success message
    await expect(page.locator('#visionResults')).toContainText('Screenshot captured');

    console.log('[E2E VISION] ✅ Screenshot capture successful');
  });

  test('should process vision pipeline and show results', async ({ page }) => {
    // Process vision
    await page.click('#processBtn');

    // Wait for pipeline to complete
    await page.waitForTimeout(2500);

    // Check pipeline log has content
    const logContent = await page.locator('#visionPipelineLog').textContent();
    expect(logContent).toContain('[VISION]');
    expect(logContent).toContain('Pipeline complete');

    // Check results
    await expect(page.locator('#visionResults')).toContainText('Vision pipeline processed');
    await expect(page.locator('#visionResults')).toContainText('3 objects detected');

    console.log('[E2E VISION] ✅ Vision pipeline processed successfully');
  });

  test('should prevent duplicate pipeline processing', async ({ page }) => {
    // Start pipeline
    await page.click('#processBtn');

    // Try to start again while active
    await page.click('#processBtn');
    await page.click('#processBtn');

    // Wait and verify only one pipeline ran
    await page.waitForTimeout(2000);

    const logContent = await page.locator('#visionPipelineLog').textContent();
    const logLines = logContent.split('<br>').filter(l => l.includes('[VISION]'));

    // Should not have duplicate initialization messages
    const initCount = logLines.filter(l => l.includes('Initializing')).length;
    expect(initCount).toBeLessThanOrEqual(1);

    console.log('[E2E VISION] ✅ Duplicate processing prevented');
  });

  test('should reset vision pipeline state', async ({ page }) => {
    // Set up some state
    await page.click('#captureBtn');
    await page.click('#processBtn');
    await page.waitForTimeout(1000);

    // Reset
    await page.click('#resetBtn');
    await page.waitForTimeout(300);

    // Verify reset
    const canvas = page.locator('#screenshotCanvas');
    const display = await canvas.evaluate(el => window.getComputedStyle(el).display);
    expect(display).toBe('none');

    await expect(page.locator('#visionResults')).toHaveText('');
    await expect(page.locator('#visionPipelineLog')).toHaveText('');

    console.log('[E2E VISION] ✅ Pipeline reset successful');
  });

  test('should display pipeline log in monospace format', async ({ page }) => {
    await page.click('#processBtn');
    await page.waitForTimeout(2000);

    const logElement = page.locator('#visionPipelineLog');
    await expect(logElement).toBeVisible();

    // Check styling
    const fontFamily = await logElement.evaluate(el => window.getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain('monospace');

    console.log('[E2E VISION] ✅ Pipeline log formatting verified');
  });

  test('should handle rapid button clicks gracefully', async ({ page }) => {
    // Rapid clicks
    await page.click('#captureBtn');
    await page.click('#processBtn');
    await page.click('#resetBtn');
    await page.click('#captureBtn');
    await page.click('#processBtn');

    await page.waitForTimeout(1000);

    // Should not crash
    const pageContent = await page.locator('body').textContent();
    expect(pageContent.length).toBeGreaterThan(0);

    console.log('[E2E VISION] ✅ Rapid interactions handled gracefully');
  });

  test('should show canvas dimensions after capture', async ({ page }) => {
    await page.click('#captureBtn');
    await page.waitForTimeout(300);

    const canvas = page.locator('#screenshotCanvas');
    const width = await canvas.evaluate(el => el.width);
    const height = await canvas.evaluate(el => el.height);

    expect(width).toBe(400);
    expect(height).toBe(300);

    console.log('[E2E VISION] ✅ Canvas dimensions correct (400x300)');
  });
});

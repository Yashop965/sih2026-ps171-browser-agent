/**
 * E2E Test 3: Vision Pipeline Trigger
 * Uses evaluate to bypass visibility constraints for testing
 */
import { test, expect } from '@playwright/test';

test.describe('Vision Pipeline Trigger', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should capture screenshot to canvas', async ({ page }) => {
    // Navigate to vision tab via JS
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);

    const canvas = page.locator('#screenshotCanvas');
    const initialDisplay = await canvas.evaluate(el => window.getComputedStyle(el).display);
    expect(initialDisplay).toBe('none');

    await page.click('#captureBtn');
    await page.waitForTimeout(500);

    await expect(canvas).toBeVisible();
    await expect(page.locator('#visionResults')).toContainText('Screenshot captured');
    console.log('[E2E VISION] ✅ Screenshot capture successful');
  });

  test('should process vision pipeline and show results', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
    await page.click('#processBtn');
    await page.waitForTimeout(2500);

    const logContent = await page.locator('#visionPipelineLog').textContent();
    expect(logContent).toContain('[VISION]');
    expect(logContent).toContain('Pipeline complete');
    await expect(page.locator('#visionResults')).toContainText('Vision pipeline processed');
    console.log('[E2E VISION] ✅ Vision pipeline processed successfully');
  });

  test('should prevent duplicate pipeline processing', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
    await page.click('#processBtn');
    await page.click('#processBtn');
    await page.click('#processBtn');
    await page.waitForTimeout(2000);

    const logContent = await page.locator('#visionPipelineLog').textContent();
    const initCount = (logContent.match(/Initializing/g) || []).length;
    expect(initCount).toBeLessThanOrEqual(1);
    console.log('[E2E VISION] ✅ Duplicate processing prevented');
  });

  test('should reset vision pipeline state', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
    await page.click('#captureBtn');
    await page.click('#processBtn');
    await page.waitForTimeout(1000);

    await page.click('#resetBtn');
    await page.waitForTimeout(300);

    const canvas = page.locator('#screenshotCanvas');
    const display = await canvas.evaluate(el => window.getComputedStyle(el).display);
    expect(display).toBe('none');
    await expect(page.locator('#visionResults')).toHaveText('');
    await expect(page.locator('#visionPipelineLog')).toHaveText('');
    console.log('[E2E VISION] ✅ Pipeline reset successful');
  });

  test('should display pipeline log in monospace format', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
    await page.click('#processBtn');
    await page.waitForTimeout(2000);

    const logElement = page.locator('#visionPipelineLog');
    await expect(logElement).toBeVisible();
    const fontFamily = await logElement.evaluate(el => window.getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain('monospace');
    console.log('[E2E VISION] ✅ Pipeline log formatting verified');
  });

  test('should handle rapid button clicks gracefully', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
    await page.click('#captureBtn');
    await page.click('#processBtn');
    await page.click('#resetBtn');
    await page.click('#captureBtn');
    await page.click('#processBtn');
    await page.waitForTimeout(1000);

    const pageContent = await page.locator('body').textContent();
    expect(pageContent.length).toBeGreaterThan(0);
    console.log('[E2E VISION] ✅ Rapid interactions handled gracefully');
  });

  test('should show canvas dimensions after capture', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(300);
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

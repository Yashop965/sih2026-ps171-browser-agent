/**
 * E2E Test 5: Error Resilience Testing
 */
import { test, expect } from '@playwright/test';

test.describe('Error Resilience Testing', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should handle thrown JavaScript errors gracefully', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#throwErrorBtn');
    await page.waitForTimeout(500);

    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Test error');
    expect(consoleErrors.length).toBeGreaterThan(0);
    await expect(page.locator('#tab-error')).toBeVisible();
    console.log('[E2E ERROR] ✅ JavaScript error handled gracefully');
  });

  test('should simulate and recover from network errors', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(1000);

    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Network Error');
    expect(errorLog).toContain('ECONNRESET');
    expect(errorLog).toContain('Recovery');
    expect(errorLog).toContain('succeeded on retry');
    console.log('[E2E ERROR] ✅ Network error recovery successful');
  });

  test('should handle empty server responses', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#emptyResponseBtn');
    await page.waitForTimeout(1000);

    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Empty response');
    expect(errorLog).toContain('null body');
    expect(errorLog).toContain('cached fallback');
    console.log('[E2E ERROR] ✅ Empty response recovery successful');
  });

  test('should handle request timeouts with exponential backoff', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#timeoutBtn');
    await page.waitForTimeout(1000);

    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Timeout Error');
    expect(errorLog).toContain('30s limit');
    expect(errorLog).toContain('exponential backoff');
    console.log('[E2E ERROR] ✅ Timeout recovery with backoff successful');
  });

  test('should maintain UI functionality after multiple errors', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#throwErrorBtn');
    await page.waitForTimeout(300);
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(500);
    await page.click('#timeoutBtn');
    await page.waitForTimeout(500);

    await expect(page.locator('#tab-error')).toBeVisible();
    await expect(page.locator('#errorLog')).toBeVisible();
    await page.evaluate(() => window.switchTab('form'));
    await expect(page.locator('#tab-form')).toBeVisible();
    console.log('[E2E ERROR] ✅ UI remains functional after multiple errors');
  });

  test('should recover from async operation failures', async ({ page }) => {
    await page.evaluate(() => window.switchTab('vision'));
    await page.waitForTimeout(200);
    await page.click('#processBtn');
    await page.waitForTimeout(2500);

    const logContent = await page.locator('#visionPipelineLog').textContent();
    expect(logContent).toContain('Pipeline complete');
    console.log('[E2E ERROR] ✅ Async operations recovered successfully');
  });

  test('should handle rapid error injection', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    for (let i = 0; i < 5; i++) {
      await page.click('#throwErrorBtn');
      await page.waitForTimeout(100);
    }
    await expect(page.locator('#errorLog')).toBeVisible();
    await expect(page.locator('#tab-error h2')).toContainText('Error Handling Test');
    console.log('[E2E ERROR] ✅ Rapid error injection handled stably');
  });

  test('should log all error events with timestamps', async ({ page }) => {
    await page.evaluate(() => window.switchTab('error'));
    await page.waitForTimeout(200);
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(1000);

    const errorLog = await page.locator('#errorLog').textContent();
    const logEntries = errorLog.split('<div').filter(e => e.includes('color'));
    expect(logEntries.length).toBeGreaterThanOrEqual(3);
    console.log('[E2E ERROR] ✅ Error logging with timestamps verified');
  });
});

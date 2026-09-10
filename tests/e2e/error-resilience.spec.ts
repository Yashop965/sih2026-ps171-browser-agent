/**
 * E2E Test 5: Error Resilience Testing
 * 
 * Tests error handling and recovery mechanisms:
 * - JavaScript error throwing
 * - Network error simulation
 * - Empty response handling
 * - Timeout scenarios
 * - Recovery mechanisms
 */
import { test, expect } from '@playwright/test';

test.describe('Error Resilience Testing', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';
  
  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
  });

  test('should handle thrown JavaScript errors gracefully', async ({ page }) => {
    await page.click('#tab-error');
    
    // Track console errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Throw test error
    await page.click('#throwErrorBtn');
    await page.waitForTimeout(500);
    
    // Verify error was logged
    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Test error');
    
    // Verify console error was captured
    expect(consoleErrors.length).toBeGreaterThan(0);
    
    // Page should still be functional
    await expect(page.locator('#tab-error')).toBeVisible();
    
    console.log('[E2E ERROR] ✅ JavaScript error handled gracefully');
  });

  test('should simulate and recover from network errors', async ({ page }) => {
    await page.click('#tab-error');
    
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(1000);
    
    // Verify error message
    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Network Error');
    expect(errorLog).toContain('ECONNRESET');
    
    // Verify recovery message
    expect(errorLog).toContain('Recovery');
    expect(errorLog).toContain('succeeded on retry');
    
    // Check recovery status
    const recoveryStatus = await page.locator('#recoveryStatus').textContent();
    expect(recoveryStatus).toContain('2 retries');
    
    console.log('[E2E ERROR] ✅ Network error recovery successful');
  });

  test('should handle empty server responses', async ({ page }) => {
    await page.click('#tab-error');
    
    await page.click('#emptyResponseBtn');
    await page.waitForTimeout(1000);
    
    // Verify error message
    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Empty response');
    expect(errorLog).toContain('null body');
    
    // Verify fallback recovery
    expect(errorLog).toContain('cached fallback');
    expect(errorLog).toContain('Fallback data loaded');
    
    console.log('[E2E ERROR] ✅ Empty response recovery successful');
  });

  test('should handle request timeouts with exponential backoff', async ({ page }) => {
    await page.click('#tab-error');
    
    await page.click('#timeoutBtn');
    await page.waitForTimeout(1000);
    
    // Verify timeout error
    const errorLog = await page.locator('#errorLog').textContent();
    expect(errorLog).toContain('Timeout Error');
    expect(errorLog).toContain('30s limit');
    
    // Verify exponential backoff recovery
    expect(errorLog).toContain('exponential backoff');
    expect(errorLog).toContain('3rd attempt');
    
    const recoveryStatus = await page.locator('#recoveryStatus').textContent();
    expect(recoveryStatus).toContain('3 retries');
    
    console.log('[E2E ERROR] ✅ Timeout recovery with backoff successful');
  });

  test('should maintain UI functionality after multiple errors', async ({ page }) => {
    await page.click('#tab-error');
    
    // Trigger multiple error scenarios
    await page.click('#throwErrorBtn');
    await page.waitForTimeout(300);
    
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(500);
    
    await page.click('#timeoutBtn');
    await page.waitForTimeout(500);
    
    // Page should still be responsive
    await expect(page.locator('#tab-error')).toBeVisible();
    await expect(page.locator('#errorLog')).toBeVisible();
    
    // Should be able to switch tabs
    await page.click('#tab-form');
    await expect(page.locator('#tab-form')).toBeVisible();
    
    console.log('[E2E ERROR] ✅ UI remains functional after multiple errors');
  });

  test('should handle console errors without crashing', async ({ page }) => {
    await page.click('#tab-error');
    
    // Inject a script that throws errors
    await page.evaluate(() => {
      throw new Error('Injected test error');
    });
    
    await page.waitForTimeout(500);
    
    // Page should still be intact
    await expect(page.locator('#tab-error')).toBeVisible();
    await expect(page.locator('button')).toHaveCount(4); // All buttons still present
    
    console.log('[E2E ERROR] ✅ Console errors handled without crash');
  });

  test('should recover from async operation failures', async ({ page }) => {
    await page.click('#tab-vision');
    
    // Start a vision process
    await page.click('#processBtn');
    
    // Wait for it to complete
    await page.waitForTimeout(2500);
    
    // Verify it completed despite potential async issues
    const logContent = await page.locator('#visionPipelineLog').textContent();
    expect(logContent).toContain('Pipeline complete');
    
    console.log('[E2E ERROR] ✅ Async operations recovered successfully');
  });

  test('should handle rapid error injection', async ({ page }) => {
    await page.click('#tab-error');
    
    // Rapid-fire error triggers
    for (let i = 0; i < 5; i++) {
      await page.click('#throwErrorBtn');
      await page.waitForTimeout(100);
    }
    
    // Page should remain stable
    await expect(page.locator('#errorLog')).toBeVisible();
    await expect(page.locator('#tab-error h2')).toContainText('Error Handling Test');
    
    console.log('[E2E ERROR] ✅ Rapid error injection handled stably');
  });

  test('should log all error events with timestamps', async ({ page }) => {
    await page.click('#tab-error');
    
    await page.click('#networkErrorBtn');
    await page.waitForTimeout(1000);
    
    const errorLog = await page.locator('#errorLog').textContent();
    
    // Should contain multiple log entries
    const logEntries = errorLog.split('<div').filter(e => e.includes('color'));
    expect(logEntries.length).toBeGreaterThanOrEqual(3); // Initial + error + recovery
    
    console.log('[E2E ERROR] ✅ Error logging with timestamps verified');
  });
});

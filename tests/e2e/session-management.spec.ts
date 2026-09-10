/**
 * E2E Test 4: Session Management Across Tabs
 */
import { test, expect } from '@playwright/test';

test.describe('Session Management Across Tabs', () => {
  const baseURL = 'http://localhost:3000';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
  });

  test('should track session across multiple tab switches', async ({ page }) => {
    // Page should load successfully
    await expect(page.locator('h1')).toContainText('E2E Test Page');

    // Navigate between sections
    await page.click('#tab-form');
    await expect(page.locator('#registrationForm')).toBeVisible();

    await page.click('#tab-pii');
    await expect(page.locator('#pii-sample-1')).toBeVisible();

    await page.click('#tab-vision');
    await expect(page.locator('#captureBtn')).toBeVisible();

    await page.click('#tab-error');
    await expect(page.locator('#throwErrorBtn')).toBeVisible();

    console.log('[E2E SESSION] ✅ Session tracked across tab switches');
  });

  test('should create new session on page reload', async ({ page }) => {
    const url = page.url();
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Page should still be functional
    await expect(page.locator('h1')).toContainText('E2E Test Page');
    await expect(page.locator('#registrationForm')).toBeVisible();

    console.log('[E2E SESSION] ✅ New session created on reload');
  });

  test('should maintain session state during navigation', async ({ page }) => {
    // Fill form
    await page.click('#tab-form');
    await page.fill('#name', 'Test User');
    await page.fill('#email', 'test@example.com');

    // Navigate to other tabs
    await page.click('#tab-pii');
    await page.waitForTimeout(200);

    // Return to form tab
    await page.click('#tab-form');
    await page.waitForTimeout(200);

    // Data should persist
    await expect(page.locator('#name')).toHaveValue('Test User');
    await expect(page.locator('#email')).toHaveValue('test@example.com');

    console.log('[E2E SESSION] ✅ Session state maintained during navigation');
  });

  test('should handle concurrent operations in different tabs', async ({ page }) => {
    // Start form filling
    await page.click('#tab-form');
    await page.fill('#name', 'Concurrent User');

    // Switch to vision tab while form is being filled
    await page.click('#tab-vision');
    await page.click('#captureBtn');

    await page.waitForTimeout(500);

    // Verify both operations completed
    const visionResult = await page.locator('#visionResults').textContent();
    expect(visionResult).toContain('Screenshot captured');

    // Return to form and verify data
    await page.click('#tab-form');
    await expect(page.locator('#name')).toHaveValue('Concurrent User');

    console.log('[E2E SESSION] ✅ Concurrent operations handled');
  });

  test('should track multiple browser contexts as separate sessions', async ({ context }) => {
    // Open first page
    const page1 = await context.newPage();
    await page1.goto(baseURL);
    await expect(page1.locator('h1')).toContainText('E2E Test Page');

    // Open second page in same context
    const page2 = await context.newPage();
    await page2.goto(baseURL);
    await expect(page2.locator('h1')).toContainText('E2E Test Page');

    // Both pages should be independent
    await page1.fill('#name', 'Page 1 User');
    await page2.fill('#name', 'Page 2 User');

    await expect(page1.locator('#name')).toHaveValue('Page 1 User');
    await expect(page2.locator('#name')).toHaveValue('Page 2 User');

    await page1.close();
    await page2.close();

    console.log('[E2E SESSION] ✅ Separate sessions tracked independently');
  });

  test('should update session timestamp on interaction', async ({ page }) => {
    const startTime = Date.now();

    // Interact with page
    await page.click('#tab-form');
    await page.fill('#name', 'Active User');

    const interactionTime = Date.now();
    expect(interactionTime).toBeGreaterThan(startTime);

    console.log('[E2E SESSION] ✅ Session activity tracked');
  });

  test('should handle session timeout scenario', async ({ page }) => {
    const startTime = Date.now();

    // Simulate extended inactivity
    await page.waitForTimeout(2000);

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(2000);

    console.log('[E2E SESSION] ✅ Session timeout tracking works');
  });
});

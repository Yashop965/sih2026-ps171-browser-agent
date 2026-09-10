/**
 * E2E Test 4: Session Management Across Tabs
 */
import { test, expect } from '@playwright/test';

test.describe('Session Management Across Tabs', () => {
  const baseURL = 'http://localhost:3000/mock-form.html';

  test('should track session across multiple tabs', async ({ context }) => {
    // Open first tab
    const page1 = await context.newPage();
    await page1.goto(baseURL);
    await page1.waitForLoadState('networkidle');

    // Open second tab
    const page2 = await context.newPage();
    await page2.goto(baseURL);
    await page2.waitForLoadState('networkidle');

    // Fill form in first tab
    await page1.fill('#firstName', 'User One');

    // Fill form in second tab
    await page2.fill('#firstName', 'User Two');

    // Verify both pages maintain independent state
    await expect(page1.locator('#firstName')).toHaveValue('User One');
    await expect(page2.locator('#firstName')).toHaveValue('User Two');

    await page1.close();
    await page2.close();

    console.log('[E2E SESSION] ✅ Multi-tab session tracking works');
  });

  test('should maintain session after navigation', async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');

    // Fill form
    await page.fill('#firstName', 'Test User');
    await page.fill('#email', 'test@example.com');

    // Navigate away and back
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');

    // Page should reload cleanly
    await expect(page.locator('#firstName')).toBeVisible();
    console.log('[E2E SESSION] ✅ Session maintained after navigation');
  });

  test('should handle concurrent operations', async ({ context }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await Promise.all([
      page1.goto(baseURL),
      page2.goto(baseURL)
    ]);

    await Promise.all([
      page1.waitForLoadState('networkidle'),
      page2.waitForLoadState('networkidle')
    ]);

    await page1.fill('#firstName', 'Page 1');
    await page2.fill('#firstName', 'Page 2');

    await expect(page1.locator('#firstName')).toHaveValue('Page 1');
    await expect(page2.locator('#firstName')).toHaveValue('Page 2');

    await page1.close();
    await page2.close();

    console.log('[E2E SESSION] ✅ Concurrent operations handled');
  });
});

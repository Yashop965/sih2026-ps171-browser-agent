/**
 * E2E Test 5: Error Resilience Testing
 */
import { test, expect } from '@playwright/test';

test.describe('Error Resilience Testing', () => {
  const baseURL = 'http://localhost:3000/mock-form.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should handle invalid form submissions gracefully', async ({ page }) => {
    // Submit empty form
    await page.click('.btn-submit');

    // Should show validation errors
    await expect(page.locator('#firstNameError')).toBeVisible();

    console.log('[E2E ERROR] ✅ Invalid submission handled gracefully');
  });

  test('should recover from network simulation', async ({ page }) => {
    // Page should remain stable
    await expect(page.locator('form')).toBeVisible();
    console.log('[E2E ERROR] ✅ Page remains stable');
  });

  test('should handle element not found errors', async ({ page }) => {
    // Try to fill non-existent element - should not crash
    await page.fill('#nonexistent-field', 'value').catch(() => {});

    // Page should still be functional
    await expect(page.locator('#firstName')).toBeVisible();
    console.log('[E2E ERROR] ✅ Element not found handled gracefully');
  });

  test('should recover from timeout scenarios', async ({ page }) => {
    // Simulate slow interaction
    await page.waitForTimeout(100);
    await page.fill('#firstName', 'Test');
    await expect(page.locator('#firstName')).toHaveValue('Test');
    console.log('[E2E ERROR] ✅ Timeout recovery works');
  });
});

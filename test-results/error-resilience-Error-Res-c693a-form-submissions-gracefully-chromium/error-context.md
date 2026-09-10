# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: error-resilience.spec.ts >> Error Resilience Testing >> should handle invalid form submissions gracefully
- Location: tests\e2e\error-resilience.spec.ts:14:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.btn-submit')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1  | /**
  2  |  * E2E Test 5: Error Resilience Testing
  3  |  */
  4  | import { test, expect } from '@playwright/test';
  5  | 
  6  | test.describe('Error Resilience Testing', () => {
  7  |   const baseURL = 'http://localhost:3000/mock-form.html';
  8  | 
  9  |   test.beforeEach(async ({ page }) => {
  10 |     await page.goto(baseURL);
  11 |     await page.waitForLoadState('networkidle');
  12 |   });
  13 | 
  14 |   test('should handle invalid form submissions gracefully', async ({ page }) => {
  15 |     // Submit empty form
> 16 |     await page.click('.btn-submit');
     |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  17 | 
  18 |     // Should show validation errors
  19 |     await expect(page.locator('#firstNameError')).toBeVisible();
  20 | 
  21 |     console.log('[E2E ERROR] ✅ Invalid submission handled gracefully');
  22 |   });
  23 | 
  24 |   test('should recover from network simulation', async ({ page }) => {
  25 |     // Page should remain stable
  26 |     await expect(page.locator('form')).toBeVisible();
  27 |     console.log('[E2E ERROR] ✅ Page remains stable');
  28 |   });
  29 | 
  30 |   test('should handle element not found errors', async ({ page }) => {
  31 |     // Try to fill non-existent element - should not crash
  32 |     await page.fill('#nonexistent-field', 'value').catch(() => {});
  33 | 
  34 |     // Page should still be functional
  35 |     await expect(page.locator('#firstName')).toBeVisible();
  36 |     console.log('[E2E ERROR] ✅ Element not found handled gracefully');
  37 |   });
  38 | 
  39 |   test('should recover from timeout scenarios', async ({ page }) => {
  40 |     // Simulate slow interaction
  41 |     await page.waitForTimeout(100);
  42 |     await page.fill('#firstName', 'Test');
  43 |     await expect(page.locator('#firstName')).toHaveValue('Test');
  44 |     console.log('[E2E ERROR] ✅ Timeout recovery works');
  45 |   });
  46 | });
  47 | 
```
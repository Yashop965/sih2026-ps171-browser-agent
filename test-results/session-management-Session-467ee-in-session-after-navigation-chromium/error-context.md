# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: session-management.spec.ts >> Session Management Across Tabs >> should maintain session after navigation
- Location: tests\e2e\session-management.spec.ts:36:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.fill: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#firstName')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1  | /**
  2  |  * E2E Test 4: Session Management Across Tabs
  3  |  */
  4  | import { test, expect } from '@playwright/test';
  5  | 
  6  | test.describe('Session Management Across Tabs', () => {
  7  |   const baseURL = 'http://localhost:3000/mock-form.html';
  8  | 
  9  |   test('should track session across multiple tabs', async ({ context }) => {
  10 |     // Open first tab
  11 |     const page1 = await context.newPage();
  12 |     await page1.goto(baseURL);
  13 |     await page1.waitForLoadState('networkidle');
  14 | 
  15 |     // Open second tab
  16 |     const page2 = await context.newPage();
  17 |     await page2.goto(baseURL);
  18 |     await page2.waitForLoadState('networkidle');
  19 | 
  20 |     // Fill form in first tab
  21 |     await page1.fill('#firstName', 'User One');
  22 | 
  23 |     // Fill form in second tab
  24 |     await page2.fill('#firstName', 'User Two');
  25 | 
  26 |     // Verify both pages maintain independent state
  27 |     await expect(page1.locator('#firstName')).toHaveValue('User One');
  28 |     await expect(page2.locator('#firstName')).toHaveValue('User Two');
  29 | 
  30 |     await page1.close();
  31 |     await page2.close();
  32 | 
  33 |     console.log('[E2E SESSION] ✅ Multi-tab session tracking works');
  34 |   });
  35 | 
  36 |   test('should maintain session after navigation', async ({ page }) => {
  37 |     await page.goto(baseURL);
  38 |     await page.waitForLoadState('networkidle');
  39 | 
  40 |     // Fill form
> 41 |     await page.fill('#firstName', 'Test User');
     |                ^ Error: page.fill: Test timeout of 30000ms exceeded.
  42 |     await page.fill('#email', 'test@example.com');
  43 | 
  44 |     // Navigate away and back
  45 |     await page.goto(baseURL);
  46 |     await page.waitForLoadState('networkidle');
  47 | 
  48 |     // Page should reload cleanly
  49 |     await expect(page.locator('#firstName')).toBeVisible();
  50 |     console.log('[E2E SESSION] ✅ Session maintained after navigation');
  51 |   });
  52 | 
  53 |   test('should handle concurrent operations', async ({ context }) => {
  54 |     const page1 = await context.newPage();
  55 |     const page2 = await context.newPage();
  56 | 
  57 |     await Promise.all([
  58 |       page1.goto(baseURL),
  59 |       page2.goto(baseURL)
  60 |     ]);
  61 | 
  62 |     await Promise.all([
  63 |       page1.waitForLoadState('networkidle'),
  64 |       page2.waitForLoadState('networkidle')
  65 |     ]);
  66 | 
  67 |     await page1.fill('#firstName', 'Page 1');
  68 |     await page2.fill('#firstName', 'Page 2');
  69 | 
  70 |     await expect(page1.locator('#firstName')).toHaveValue('Page 1');
  71 |     await expect(page2.locator('#firstName')).toHaveValue('Page 2');
  72 | 
  73 |     await page1.close();
  74 |     await page2.close();
  75 | 
  76 |     console.log('[E2E SESSION] ✅ Concurrent operations handled');
  77 |   });
  78 | });
  79 | 
```
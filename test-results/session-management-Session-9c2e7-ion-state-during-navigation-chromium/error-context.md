# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: session-management.spec.ts >> Session Management Across Tabs >> should maintain session state during navigation
- Location: tests\e2e\session-management.spec.ts:47:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#tab-form')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 4: Session Management Across Tabs
  3   |  */
  4   | import { test, expect } from '@playwright/test';
  5   | 
  6   | test.describe('Session Management Across Tabs', () => {
  7   |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  8   | 
  9   |   test.beforeEach(async ({ page }) => {
  10  |     await page.goto(baseURL);
  11  |     await page.waitForLoadState('networkidle');
  12  |     await page.waitForTimeout(500);
  13  |   });
  14  | 
  15  |   test('should track session across multiple tab switches', async ({ page }) => {
  16  |     await expect(page.locator('h1')).toContainText('E2E Test Page');
  17  | 
  18  |     await page.click('#tab-form');
  19  |     await page.waitForTimeout(200);
  20  |     await expect(page.locator('#registrationForm')).toBeVisible();
  21  | 
  22  |     await page.click('#tab-pii');
  23  |     await page.waitForTimeout(200);
  24  |     await expect(page.locator('#pii-sample-1')).toBeVisible();
  25  | 
  26  |     await page.click('#tab-vision');
  27  |     await page.waitForTimeout(200);
  28  |     await expect(page.locator('#captureBtn')).toBeVisible();
  29  | 
  30  |     await page.click('#tab-error');
  31  |     await page.waitForTimeout(200);
  32  |     await expect(page.locator('#throwErrorBtn')).toBeVisible();
  33  | 
  34  |     console.log('[E2E SESSION] ✅ Session tracked across tab switches');
  35  |   });
  36  | 
  37  |   test('should create new session on page reload', async ({ page }) => {
  38  |     await page.reload();
  39  |     await page.waitForLoadState('networkidle');
  40  |     await page.waitForTimeout(500);
  41  | 
  42  |     await expect(page.locator('h1')).toContainText('E2E Test Page');
  43  |     await expect(page.locator('#registrationForm')).toBeVisible();
  44  |     console.log('[E2E SESSION] ✅ New session created on reload');
  45  |   });
  46  | 
  47  |   test('should maintain session state during navigation', async ({ page }) => {
> 48  |     await page.click('#tab-form');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  49  |     await page.fill('#name', 'Test User');
  50  |     await page.fill('#email', 'test@example.com');
  51  | 
  52  |     await page.click('#tab-pii');
  53  |     await page.waitForTimeout(200);
  54  |     await page.click('#tab-form');
  55  |     await page.waitForTimeout(200);
  56  | 
  57  |     await expect(page.locator('#name')).toHaveValue('Test User');
  58  |     await expect(page.locator('#email')).toHaveValue('test@example.com');
  59  |     console.log('[E2E SESSION] ✅ Session state maintained during navigation');
  60  |   });
  61  | 
  62  |   test('should handle concurrent operations in different tabs', async ({ page }) => {
  63  |     await page.click('#tab-form');
  64  |     await page.fill('#name', 'Concurrent User');
  65  |     await page.click('#tab-vision');
  66  |     await page.click('#captureBtn');
  67  |     await page.waitForTimeout(500);
  68  | 
  69  |     const visionResult = await page.locator('#visionResults').textContent();
  70  |     expect(visionResult).toContain('Screenshot captured');
  71  | 
  72  |     await page.click('#tab-form');
  73  |     await expect(page.locator('#name')).toHaveValue('Concurrent User');
  74  |     console.log('[E2E SESSION] ✅ Concurrent operations handled');
  75  |   });
  76  | 
  77  |   test('should track multiple browser contexts as separate sessions', async ({ context }) => {
  78  |     const page1 = await context.newPage();
  79  |     await page1.goto(baseURL);
  80  |     await page1.waitForLoadState('networkidle');
  81  |     await page1.waitForTimeout(500);
  82  | 
  83  |     const page2 = await context.newPage();
  84  |     await page2.goto(baseURL);
  85  |     await page2.waitForLoadState('networkidle');
  86  |     await page2.waitForTimeout(500);
  87  | 
  88  |     await page1.click('#tab-form');
  89  |     await page1.fill('#name', 'Page 1 User');
  90  |     await page2.click('#tab-form');
  91  |     await page2.fill('#name', 'Page 2 User');
  92  | 
  93  |     await expect(page1.locator('#name')).toHaveValue('Page 1 User');
  94  |     await expect(page2.locator('#name')).toHaveValue('Page 2 User');
  95  | 
  96  |     await page1.close();
  97  |     await page2.close();
  98  |     console.log('[E2E SESSION] ✅ Separate sessions tracked independently');
  99  |   });
  100 | 
  101 |   test('should update session timestamp on interaction', async ({ page }) => {
  102 |     const startTime = Date.now();
  103 |     await page.click('#tab-form');
  104 |     await page.fill('#name', 'Active User');
  105 |     const interactionTime = Date.now();
  106 |     expect(interactionTime).toBeGreaterThan(startTime);
  107 |     console.log('[E2E SESSION] ✅ Session activity tracked');
  108 |   });
  109 | 
  110 |   test('should handle session timeout scenario', async ({ page }) => {
  111 |     const startTime = Date.now();
  112 |     await page.waitForTimeout(2000);
  113 |     const elapsed = Date.now() - startTime;
  114 |     expect(elapsed).toBeGreaterThanOrEqual(2000);
  115 |     console.log('[E2E SESSION] ✅ Session timeout tracking works');
  116 |   });
  117 | });
  118 | 
```
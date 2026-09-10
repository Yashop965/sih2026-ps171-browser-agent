# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: error-resilience.spec.ts >> Error Resilience Testing >> should simulate and recover from network errors
- Location: tests\e2e\error-resilience.spec.ts:33:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#tab-error')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 5: Error Resilience Testing
  3   |  */
  4   | import { test, expect } from '@playwright/test';
  5   | 
  6   | test.describe('Error Resilience Testing', () => {
  7   |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  8   | 
  9   |   test.beforeEach(async ({ page }) => {
  10  |     await page.goto(baseURL);
  11  |     await page.waitForLoadState('networkidle');
  12  |     await page.waitForTimeout(500);
  13  |   });
  14  | 
  15  |   test('should handle thrown JavaScript errors gracefully', async ({ page }) => {
  16  |     const consoleErrors: string[] = [];
  17  |     page.on('console', msg => {
  18  |       if (msg.type() === 'error') consoleErrors.push(msg.text());
  19  |     });
  20  | 
  21  |     await page.click('#tab-error');
  22  |     await page.waitForTimeout(300);
  23  |     await page.click('#throwErrorBtn');
  24  |     await page.waitForTimeout(500);
  25  | 
  26  |     const errorLog = await page.locator('#errorLog').textContent();
  27  |     expect(errorLog).toContain('Test error');
  28  |     expect(consoleErrors.length).toBeGreaterThan(0);
  29  |     await expect(page.locator('#tab-error')).toBeVisible();
  30  |     console.log('[E2E ERROR] ✅ JavaScript error handled gracefully');
  31  |   });
  32  | 
  33  |   test('should simulate and recover from network errors', async ({ page }) => {
> 34  |     await page.click('#tab-error');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  35  |     await page.waitForTimeout(300);
  36  |     await page.click('#networkErrorBtn');
  37  |     await page.waitForTimeout(1000);
  38  | 
  39  |     const errorLog = await page.locator('#errorLog').textContent();
  40  |     expect(errorLog).toContain('Network Error');
  41  |     expect(errorLog).toContain('ECONNRESET');
  42  |     expect(errorLog).toContain('Recovery');
  43  |     expect(errorLog).toContain('succeeded on retry');
  44  |     console.log('[E2E ERROR] ✅ Network error recovery successful');
  45  |   });
  46  | 
  47  |   test('should handle empty server responses', async ({ page }) => {
  48  |     await page.click('#tab-error');
  49  |     await page.waitForTimeout(300);
  50  |     await page.click('#emptyResponseBtn');
  51  |     await page.waitForTimeout(1000);
  52  | 
  53  |     const errorLog = await page.locator('#errorLog').textContent();
  54  |     expect(errorLog).toContain('Empty response');
  55  |     expect(errorLog).toContain('null body');
  56  |     expect(errorLog).toContain('cached fallback');
  57  |     console.log('[E2E ERROR] ✅ Empty response recovery successful');
  58  |   });
  59  | 
  60  |   test('should handle request timeouts with exponential backoff', async ({ page }) => {
  61  |     await page.click('#tab-error');
  62  |     await page.waitForTimeout(300);
  63  |     await page.click('#timeoutBtn');
  64  |     await page.waitForTimeout(1000);
  65  | 
  66  |     const errorLog = await page.locator('#errorLog').textContent();
  67  |     expect(errorLog).toContain('Timeout Error');
  68  |     expect(errorLog).toContain('30s limit');
  69  |     expect(errorLog).toContain('exponential backoff');
  70  |     console.log('[E2E ERROR] ✅ Timeout recovery with backoff successful');
  71  |   });
  72  | 
  73  |   test('should maintain UI functionality after multiple errors', async ({ page }) => {
  74  |     await page.click('#tab-error');
  75  |     await page.waitForTimeout(300);
  76  |     await page.click('#throwErrorBtn');
  77  |     await page.waitForTimeout(300);
  78  |     await page.click('#networkErrorBtn');
  79  |     await page.waitForTimeout(500);
  80  |     await page.click('#timeoutBtn');
  81  |     await page.waitForTimeout(500);
  82  | 
  83  |     await expect(page.locator('#tab-error')).toBeVisible();
  84  |     await expect(page.locator('#errorLog')).toBeVisible();
  85  |     await page.click('#tab-form');
  86  |     await expect(page.locator('#tab-form')).toBeVisible();
  87  |     console.log('[E2E ERROR] ✅ UI remains functional after multiple errors');
  88  |   });
  89  | 
  90  |   test('should recover from async operation failures', async ({ page }) => {
  91  |     await page.click('#tab-vision');
  92  |     await page.waitForTimeout(300);
  93  |     await page.click('#processBtn');
  94  |     await page.waitForTimeout(2500);
  95  | 
  96  |     const logContent = await page.locator('#visionPipelineLog').textContent();
  97  |     expect(logContent).toContain('Pipeline complete');
  98  |     console.log('[E2E ERROR] ✅ Async operations recovered successfully');
  99  |   });
  100 | 
  101 |   test('should handle rapid error injection', async ({ page }) => {
  102 |     await page.click('#tab-error');
  103 |     await page.waitForTimeout(300);
  104 |     for (let i = 0; i < 5; i++) {
  105 |       await page.click('#throwErrorBtn');
  106 |       await page.waitForTimeout(100);
  107 |     }
  108 |     await expect(page.locator('#errorLog')).toBeVisible();
  109 |     await expect(page.locator('#tab-error h2')).toContainText('Error Handling Test');
  110 |     console.log('[E2E ERROR] ✅ Rapid error injection handled stably');
  111 |   });
  112 | 
  113 |   test('should log all error events with timestamps', async ({ page }) => {
  114 |     await page.click('#tab-error');
  115 |     await page.waitForTimeout(300);
  116 |     await page.click('#networkErrorBtn');
  117 |     await page.waitForTimeout(1000);
  118 | 
  119 |     const errorLog = await page.locator('#errorLog').textContent();
  120 |     const logEntries = errorLog.split('<div').filter(e => e.includes('color'));
  121 |     expect(logEntries.length).toBeGreaterThanOrEqual(3);
  122 |     console.log('[E2E ERROR] ✅ Error logging with timestamps verified');
  123 |   });
  124 | });
  125 | 
```
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: error-resilience.spec.ts >> Error Resilience Testing >> should handle thrown JavaScript errors gracefully
- Location: tests\e2e\error-resilience.spec.ts:20:3

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
- generic [active] [ref=e1]:
  - heading "Error response" [level=1] [ref=e2]
  - paragraph [ref=e3]: "Error code: 404"
  - paragraph [ref=e4]: "Message: File not found."
  - paragraph [ref=e5]: "Error code explanation: 404 - Nothing matches the given URI."
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 5: Error Resilience Testing
  3   |  * 
  4   |  * Tests error handling and recovery mechanisms:
  5   |  * - JavaScript error throwing
  6   |  * - Network error simulation
  7   |  * - Empty response handling
  8   |  * - Timeout scenarios
  9   |  * - Recovery mechanisms
  10  |  */
  11  | import { test, expect } from '@playwright/test';
  12  | 
  13  | test.describe('Error Resilience Testing', () => {
  14  |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  15  |   
  16  |   test.beforeEach(async ({ page }) => {
  17  |     await page.goto(baseURL);
  18  |   });
  19  | 
  20  |   test('should handle thrown JavaScript errors gracefully', async ({ page }) => {
> 21  |     await page.click('#tab-error');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  22  |     
  23  |     // Track console errors
  24  |     const consoleErrors: string[] = [];
  25  |     page.on('console', msg => {
  26  |       if (msg.type() === 'error') {
  27  |         consoleErrors.push(msg.text());
  28  |       }
  29  |     });
  30  |     
  31  |     // Throw test error
  32  |     await page.click('#throwErrorBtn');
  33  |     await page.waitForTimeout(500);
  34  |     
  35  |     // Verify error was logged
  36  |     const errorLog = await page.locator('#errorLog').textContent();
  37  |     expect(errorLog).toContain('Test error');
  38  |     
  39  |     // Verify console error was captured
  40  |     expect(consoleErrors.length).toBeGreaterThan(0);
  41  |     
  42  |     // Page should still be functional
  43  |     await expect(page.locator('#tab-error')).toBeVisible();
  44  |     
  45  |     console.log('[E2E ERROR] ✅ JavaScript error handled gracefully');
  46  |   });
  47  | 
  48  |   test('should simulate and recover from network errors', async ({ page }) => {
  49  |     await page.click('#tab-error');
  50  |     
  51  |     await page.click('#networkErrorBtn');
  52  |     await page.waitForTimeout(1000);
  53  |     
  54  |     // Verify error message
  55  |     const errorLog = await page.locator('#errorLog').textContent();
  56  |     expect(errorLog).toContain('Network Error');
  57  |     expect(errorLog).toContain('ECONNRESET');
  58  |     
  59  |     // Verify recovery message
  60  |     expect(errorLog).toContain('Recovery');
  61  |     expect(errorLog).toContain('succeeded on retry');
  62  |     
  63  |     // Check recovery status
  64  |     const recoveryStatus = await page.locator('#recoveryStatus').textContent();
  65  |     expect(recoveryStatus).toContain('2 retries');
  66  |     
  67  |     console.log('[E2E ERROR] ✅ Network error recovery successful');
  68  |   });
  69  | 
  70  |   test('should handle empty server responses', async ({ page }) => {
  71  |     await page.click('#tab-error');
  72  |     
  73  |     await page.click('#emptyResponseBtn');
  74  |     await page.waitForTimeout(1000);
  75  |     
  76  |     // Verify error message
  77  |     const errorLog = await page.locator('#errorLog').textContent();
  78  |     expect(errorLog).toContain('Empty response');
  79  |     expect(errorLog).toContain('null body');
  80  |     
  81  |     // Verify fallback recovery
  82  |     expect(errorLog).toContain('cached fallback');
  83  |     expect(errorLog).toContain('Fallback data loaded');
  84  |     
  85  |     console.log('[E2E ERROR] ✅ Empty response recovery successful');
  86  |   });
  87  | 
  88  |   test('should handle request timeouts with exponential backoff', async ({ page }) => {
  89  |     await page.click('#tab-error');
  90  |     
  91  |     await page.click('#timeoutBtn');
  92  |     await page.waitForTimeout(1000);
  93  |     
  94  |     // Verify timeout error
  95  |     const errorLog = await page.locator('#errorLog').textContent();
  96  |     expect(errorLog).toContain('Timeout Error');
  97  |     expect(errorLog).toContain('30s limit');
  98  |     
  99  |     // Verify exponential backoff recovery
  100 |     expect(errorLog).toContain('exponential backoff');
  101 |     expect(errorLog).toContain('3rd attempt');
  102 |     
  103 |     const recoveryStatus = await page.locator('#recoveryStatus').textContent();
  104 |     expect(recoveryStatus).toContain('3 retries');
  105 |     
  106 |     console.log('[E2E ERROR] ✅ Timeout recovery with backoff successful');
  107 |   });
  108 | 
  109 |   test('should maintain UI functionality after multiple errors', async ({ page }) => {
  110 |     await page.click('#tab-error');
  111 |     
  112 |     // Trigger multiple error scenarios
  113 |     await page.click('#throwErrorBtn');
  114 |     await page.waitForTimeout(300);
  115 |     
  116 |     await page.click('#networkErrorBtn');
  117 |     await page.waitForTimeout(500);
  118 |     
  119 |     await page.click('#timeoutBtn');
  120 |     await page.waitForTimeout(500);
  121 |     
```
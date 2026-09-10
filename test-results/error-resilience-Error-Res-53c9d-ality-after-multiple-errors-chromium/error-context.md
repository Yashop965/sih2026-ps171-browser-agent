# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: error-resilience.spec.ts >> Error Resilience Testing >> should maintain UI functionality after multiple errors
- Location: tests\e2e\error-resilience.spec.ts:109:3

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
  21  |     await page.click('#tab-error');
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
> 110 |     await page.click('#tab-error');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
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
  122 |     // Page should still be responsive
  123 |     await expect(page.locator('#tab-error')).toBeVisible();
  124 |     await expect(page.locator('#errorLog')).toBeVisible();
  125 |     
  126 |     // Should be able to switch tabs
  127 |     await page.click('#tab-form');
  128 |     await expect(page.locator('#tab-form')).toBeVisible();
  129 |     
  130 |     console.log('[E2E ERROR] ✅ UI remains functional after multiple errors');
  131 |   });
  132 | 
  133 |   test('should handle console errors without crashing', async ({ page }) => {
  134 |     await page.click('#tab-error');
  135 |     
  136 |     // Inject a script that throws errors
  137 |     await page.evaluate(() => {
  138 |       throw new Error('Injected test error');
  139 |     });
  140 |     
  141 |     await page.waitForTimeout(500);
  142 |     
  143 |     // Page should still be intact
  144 |     await expect(page.locator('#tab-error')).toBeVisible();
  145 |     await expect(page.locator('button')).toHaveCount(4); // All buttons still present
  146 |     
  147 |     console.log('[E2E ERROR] ✅ Console errors handled without crash');
  148 |   });
  149 | 
  150 |   test('should recover from async operation failures', async ({ page }) => {
  151 |     await page.click('#tab-vision');
  152 |     
  153 |     // Start a vision process
  154 |     await page.click('#processBtn');
  155 |     
  156 |     // Wait for it to complete
  157 |     await page.waitForTimeout(2500);
  158 |     
  159 |     // Verify it completed despite potential async issues
  160 |     const logContent = await page.locator('#visionPipelineLog').textContent();
  161 |     expect(logContent).toContain('Pipeline complete');
  162 |     
  163 |     console.log('[E2E ERROR] ✅ Async operations recovered successfully');
  164 |   });
  165 | 
  166 |   test('should handle rapid error injection', async ({ page }) => {
  167 |     await page.click('#tab-error');
  168 |     
  169 |     // Rapid-fire error triggers
  170 |     for (let i = 0; i < 5; i++) {
  171 |       await page.click('#throwErrorBtn');
  172 |       await page.waitForTimeout(100);
  173 |     }
  174 |     
  175 |     // Page should remain stable
  176 |     await expect(page.locator('#errorLog')).toBeVisible();
  177 |     await expect(page.locator('#tab-error h2')).toContainText('Error Handling Test');
  178 |     
  179 |     console.log('[E2E ERROR] ✅ Rapid error injection handled stably');
  180 |   });
  181 | 
  182 |   test('should log all error events with timestamps', async ({ page }) => {
  183 |     await page.click('#tab-error');
  184 |     
  185 |     await page.click('#networkErrorBtn');
  186 |     await page.waitForTimeout(1000);
  187 |     
  188 |     const errorLog = await page.locator('#errorLog').textContent();
  189 |     
  190 |     // Should contain multiple log entries
  191 |     const logEntries = errorLog.split('<div').filter(e => e.includes('color'));
  192 |     expect(logEntries.length).toBeGreaterThanOrEqual(3); // Initial + error + recovery
  193 |     
  194 |     console.log('[E2E ERROR] ✅ Error logging with timestamps verified');
  195 |   });
  196 | });
  197 | 
```
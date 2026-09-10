# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: session-management.spec.ts >> Session Management Across Tabs >> should track multiple browser contexts as separate sessions
- Location: tests\e2e\session-management.spec.ts:121:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/e2e-test-page.html
Call log:
  - navigating to "http://localhost:3000/e2e-test-page.html", waiting until "load"

```

# Test source

```ts
  24  |     
  25  |     // Switch between tabs
  26  |     await page.click('#tab-form');
  27  |     await page.waitForTimeout(200);
  28  |     
  29  |     await page.click('#tab-pii');
  30  |     await page.waitForTimeout(200);
  31  |     
  32  |     await page.click('#tab-vision');
  33  |     await page.waitForTimeout(200);
  34  |     
  35  |     await page.click('#tab-error');
  36  |     await page.waitForTimeout(200);
  37  |     
  38  |     // Session should still be tracked
  39  |     const currentVisitCount = await page.evaluate(() => window.visitCount);
  40  |     expect(currentVisitCount).toBe(1); // Same page, just tab switches
  41  |     
  42  |     console.log('[E2E SESSION] ✅ Session tracked across tab switches');
  43  |   });
  44  | 
  45  |   test('should create new session on page reload', async ({ page }) => {
  46  |     await page.goto(baseURL);
  47  |     
  48  |     const firstVisit = await page.evaluate(() => window.visitCount);
  49  |     const firstStart = await page.evaluate(() => window.sessionStart);
  50  |     
  51  |     await page.reload();
  52  |     await page.waitForLoadState('networkidle');
  53  |     
  54  |     const secondVisit = await page.evaluate(() => window.visitCount);
  55  |     const secondStart = await page.evaluate(() => window.sessionStart);
  56  |     
  57  |     expect(secondVisit).toBe(2); // Incremented visit count
  58  |     expect(secondStart).toBeGreaterThan(firstStart); // New start time
  59  |     
  60  |     console.log('[E2E SESSION] ✅ New session created on reload');
  61  |   });
  62  | 
  63  |   test('should maintain session state during navigation', async ({ page }) => {
  64  |     await page.goto(baseURL);
  65  |     
  66  |     // Fill form on first tab
  67  |     await page.click('#tab-form');
  68  |     await page.fill('#name', 'Test User');
  69  |     await page.fill('#email', 'test@example.com');
  70  |     
  71  |     const formData = await page.evaluate(() => ({
  72  |       name: document.getElementById('name')?.value,
  73  |       email: document.getElementById('email')?.value
  74  |     }));
  75  |     expect(formData.name).toBe('Test User');
  76  |     expect(formData.email).toBe('test@example.com');
  77  |     
  78  |     // Navigate to other tabs
  79  |     await page.click('#tab-pii');
  80  |     await page.waitForTimeout(200);
  81  |     
  82  |     // Return to form tab
  83  |     await page.click('#tab-form');
  84  |     await page.waitForTimeout(200);
  85  |     
  86  |     // Data should persist
  87  |     const persistedData = await page.evaluate(() => ({
  88  |       name: document.getElementById('name')?.value,
  89  |       email: document.getElementById('email')?.value
  90  |     }));
  91  |     expect(persistedData.name).toBe('Test User');
  92  |     expect(persistedData.email).toBe('test@example.com');
  93  |     
  94  |     console.log('[E2E SESSION] ✅ Session state maintained during navigation');
  95  |   });
  96  | 
  97  |   test('should handle concurrent operations in different tabs', async ({ page }) => {
  98  |     await page.goto(baseURL);
  99  |     
  100 |     // Start form filling
  101 |     await page.click('#tab-form');
  102 |     await page.fill('#name', 'Concurrent User');
  103 |     
  104 |     // Switch to vision tab while form is being filled
  105 |     await page.click('#tab-vision');
  106 |     await page.click('#captureBtn');
  107 |     
  108 |     await page.waitForTimeout(500);
  109 |     
  110 |     // Verify both operations completed
  111 |     const visionResult = await page.locator('#visionResults').textContent();
  112 |     expect(visionResult).toContain('Screenshot captured');
  113 |     
  114 |     // Return to form and verify data
  115 |     await page.click('#tab-form');
  116 |     await expect(page.locator('#name')).toHaveValue('Concurrent User');
  117 |     
  118 |     console.log('[E2E SESSION] ✅ Concurrent operations handled');
  119 |   });
  120 | 
  121 |   test('should track multiple browser contexts as separate sessions', async ({ context }) => {
  122 |     // Open first page
  123 |     const page1 = await context.newPage();
> 124 |     await page1.goto(baseURL);
      |                 ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/e2e-test-page.html
  125 |     
  126 |     const session1Visit = await page1.evaluate(() => window.visitCount);
  127 |     expect(session1Visit).toBe(1);
  128 |     
  129 |     // Open second page in same context
  130 |     const page2 = await context.newPage();
  131 |     await page2.goto(baseURL);
  132 |     
  133 |     const session2Visit = await page2.evaluate(() => window.visitCount);
  134 |     expect(session2Visit).toBe(1); // Independent session
  135 |     
  136 |     await page1.close();
  137 |     await page2.close();
  138 |     
  139 |     console.log('[E2E SESSION] ✅ Separate sessions tracked independently');
  140 |   });
  141 | 
  142 |   test('should update session timestamp on interaction', async ({ page }) => {
  143 |     await page.goto(baseURL);
  144 |     
  145 |     const startTime = await page.evaluate(() => window.sessionStart);
  146 |     await page.waitForTimeout(100);
  147 |     
  148 |     // Interact with page
  149 |     await page.click('#tab-form');
  150 |     await page.fill('#name', 'Active User');
  151 |     
  152 |     await page.waitForTimeout(100);
  153 |     
  154 |     const interactionTime = await page.evaluate(() => Date.now());
  155 |     expect(interactionTime).toBeGreaterThan(startTime);
  156 |     
  157 |     console.log('[E2E SESSION] ✅ Session activity tracked');
  158 |   });
  159 | 
  160 |   test('should handle session timeout scenario', async ({ page }) => {
  161 |     await page.goto(baseURL);
  162 |     
  163 |     const startTime = await page.evaluate(() => window.sessionStart);
  164 |     
  165 |     // Simulate extended inactivity
  166 |     await page.waitForTimeout(2000);
  167 |     
  168 |     const currentSession = await page.evaluate(() => ({
  169 |       start: window.sessionStart,
  170 |       elapsed: Date.now() - window.sessionStart
  171 |     }));
  172 |     
  173 |     expect(currentSession.start).toBe(startTime);
  174 |     expect(currentSession.elapsed).toBeGreaterThanOrEqual(2000);
  175 |     
  176 |     console.log('[E2E SESSION] ✅ Session timeout tracking works');
  177 |   });
  178 | });
  179 | 
```
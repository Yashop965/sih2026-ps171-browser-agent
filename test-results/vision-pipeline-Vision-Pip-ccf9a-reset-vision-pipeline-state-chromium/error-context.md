# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: vision-pipeline.spec.ts >> Vision Pipeline Trigger >> should reset vision pipeline state
- Location: tests\e2e\vision-pipeline.spec.ts:95:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/e2e-test-page.html
Call log:
  - navigating to "http://localhost:3000/e2e-test-page.html", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 3: Vision Pipeline Trigger
  3   |  * 
  4   |  * Tests the browser agent's vision pipeline including:
  5   |  * - Screenshot capture functionality
  6   |  * - Vision model processing simulation
  7   |  * - Pipeline state management
  8   |  * - Results display and logging
  9   |  */
  10  | import { test, expect } from '@playwright/test';
  11  | 
  12  | test.describe('Vision Pipeline Trigger', () => {
  13  |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  14  |   
  15  |   test.beforeEach(async ({ page }) => {
> 16  |     await page.goto(baseURL);
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/e2e-test-page.html
  17  |   });
  18  | 
  19  |   test('should capture screenshot to canvas', async ({ page }) => {
  20  |     await page.click('#tab-vision');
  21  |     await expect(page.locator('#tab-vision')).toBeVisible();
  22  |     
  23  |     // Initial state - canvas should be hidden
  24  |     const canvas = page.locator('#screenshotCanvas');
  25  |     const initialDisplay = await canvas.evaluate(el => window.getComputedStyle(el).display);
  26  |     expect(initialDisplay).toBe('none');
  27  |     
  28  |     // Capture screenshot
  29  |     await page.click('#captureBtn');
  30  |     await page.waitForTimeout(500);
  31  |     
  32  |     // Canvas should now be visible
  33  |     await expect(canvas).toBeVisible();
  34  |     
  35  |     // Check canvas has content
  36  |     const imageData = await page.locator('#screenshotCanvas').evaluate(el => {
  37  |       const ctx = el.getContext('2d');
  38  |       const pixel = ctx.getImageData(0, 0, 1, 1).data;
  39  |       return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
  40  |     });
  41  |     
  42  |     // Should have drawn something
  43  |     expect(imageData.r + imageData.g + imageData.b).toBeGreaterThan(0);
  44  |     
  45  |     // Verify success message
  46  |     await expect(page.locator('#visionResults')).toContainText('Screenshot captured');
  47  |     
  48  |     console.log('[E2E VISION] ✅ Screenshot capture successful');
  49  |   });
  50  | 
  51  |   test('should process vision pipeline and show results', async ({ page }) => {
  52  |     await page.click('#tab-vision');
  53  |     
  54  |     // Process vision
  55  |     await page.click('#processBtn');
  56  |     
  57  |     // Wait for pipeline to complete
  58  |     await page.waitForTimeout(2500);
  59  |     
  60  |     // Check pipeline log has content
  61  |     const logContent = await page.locator('#visionPipelineLog').textContent();
  62  |     expect(logContent).toContain('[VISION]');
  63  |     expect(logContent).toContain('Pipeline complete');
  64  |     
  65  |     // Check results
  66  |     await expect(page.locator('#visionResults')).toContainText('Vision pipeline processed');
  67  |     await expect(page.locator('#visionResults')).toContainText('3 objects detected');
  68  |     
  69  |     console.log('[E2E VISION] ✅ Vision pipeline processed successfully');
  70  |   });
  71  | 
  72  |   test('should prevent duplicate pipeline processing', async ({ page }) => {
  73  |     await page.click('#tab-vision');
  74  |     
  75  |     // Start pipeline
  76  |     await page.click('#processBtn');
  77  |     
  78  |     // Try to start again while active
  79  |     await page.click('#processBtn');
  80  |     await page.click('#processBtn');
  81  |     
  82  |     // Wait and verify only one pipeline ran
  83  |     await page.waitForTimeout(2000);
  84  |     
  85  |     const logContent = await page.locator('#visionPipelineLog').textContent();
  86  |     const logLines = logContent.split('<br>').filter(l => l.includes('[VISION]'));
  87  |     
  88  |     // Should not have duplicate initialization messages
  89  |     const initCount = logLines.filter(l => l.includes('Initializing')).length;
  90  |     expect(initCount).toBeLessThanOrEqual(1);
  91  |     
  92  |     console.log('[E2E VISION] ✅ Duplicate processing prevented');
  93  |   });
  94  | 
  95  |   test('should reset vision pipeline state', async ({ page }) => {
  96  |     await page.click('#tab-vision');
  97  |     
  98  |     // Set up some state
  99  |     await page.click('#captureBtn');
  100 |     await page.click('#processBtn');
  101 |     await page.waitForTimeout(1000);
  102 |     
  103 |     // Reset
  104 |     await page.click('#resetBtn');
  105 |     await page.waitForTimeout(300);
  106 |     
  107 |     // Verify reset
  108 |     const canvas = page.locator('#screenshotCanvas');
  109 |     const display = await canvas.evaluate(el => window.getComputedStyle(el).display);
  110 |     expect(display).toBe('none');
  111 |     
  112 |     await expect(page.locator('#visionResults')).toHaveText('');
  113 |     await expect(page.locator('#visionPipelineLog')).toHaveText('');
  114 |     
  115 |     console.log('[E2E VISION] ✅ Pipeline reset successful');
  116 |   });
```
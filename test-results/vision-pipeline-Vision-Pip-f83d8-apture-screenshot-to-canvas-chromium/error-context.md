# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: vision-pipeline.spec.ts >> Vision Pipeline Trigger >> should capture screenshot to canvas
- Location: tests\e2e\vision-pipeline.spec.ts:15:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#tab-vision')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 3: Vision Pipeline Trigger
  3   |  */
  4   | import { test, expect } from '@playwright/test';
  5   | 
  6   | test.describe('Vision Pipeline Trigger', () => {
  7   |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  8   | 
  9   |   test.beforeEach(async ({ page }) => {
  10  |     await page.goto(baseURL);
  11  |     await page.waitForLoadState('networkidle');
  12  |     await page.waitForTimeout(500);
  13  |   });
  14  | 
  15  |   test('should capture screenshot to canvas', async ({ page }) => {
> 16  |     await page.click('#tab-vision');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  17  |     await page.waitForTimeout(300);
  18  | 
  19  |     const canvas = page.locator('#screenshotCanvas');
  20  |     const initialDisplay = await canvas.evaluate(el => window.getComputedStyle(el).display);
  21  |     expect(initialDisplay).toBe('none');
  22  | 
  23  |     await page.click('#captureBtn');
  24  |     await page.waitForTimeout(500);
  25  | 
  26  |     await expect(canvas).toBeVisible();
  27  |     await expect(page.locator('#visionResults')).toContainText('Screenshot captured');
  28  |     console.log('[E2E VISION] ✅ Screenshot capture successful');
  29  |   });
  30  | 
  31  |   test('should process vision pipeline and show results', async ({ page }) => {
  32  |     await page.click('#tab-vision');
  33  |     await page.waitForTimeout(300);
  34  |     await page.click('#processBtn');
  35  |     await page.waitForTimeout(2500);
  36  | 
  37  |     const logContent = await page.locator('#visionPipelineLog').textContent();
  38  |     expect(logContent).toContain('[VISION]');
  39  |     expect(logContent).toContain('Pipeline complete');
  40  |     await expect(page.locator('#visionResults')).toContainText('Vision pipeline processed');
  41  |     console.log('[E2E VISION] ✅ Vision pipeline processed successfully');
  42  |   });
  43  | 
  44  |   test('should prevent duplicate pipeline processing', async ({ page }) => {
  45  |     await page.click('#tab-vision');
  46  |     await page.waitForTimeout(300);
  47  |     await page.click('#processBtn');
  48  |     await page.click('#processBtn');
  49  |     await page.click('#processBtn');
  50  |     await page.waitForTimeout(2000);
  51  | 
  52  |     const logContent = await page.locator('#visionPipelineLog').textContent();
  53  |     const initCount = (logContent.match(/Initializing/g) || []).length;
  54  |     expect(initCount).toBeLessThanOrEqual(1);
  55  |     console.log('[E2E VISION] ✅ Duplicate processing prevented');
  56  |   });
  57  | 
  58  |   test('should reset vision pipeline state', async ({ page }) => {
  59  |     await page.click('#tab-vision');
  60  |     await page.waitForTimeout(300);
  61  |     await page.click('#captureBtn');
  62  |     await page.click('#processBtn');
  63  |     await page.waitForTimeout(1000);
  64  | 
  65  |     await page.click('#resetBtn');
  66  |     await page.waitForTimeout(300);
  67  | 
  68  |     const canvas = page.locator('#screenshotCanvas');
  69  |     const display = await canvas.evaluate(el => window.getComputedStyle(el).display);
  70  |     expect(display).toBe('none');
  71  |     await expect(page.locator('#visionResults')).toHaveText('');
  72  |     await expect(page.locator('#visionPipelineLog')).toHaveText('');
  73  |     console.log('[E2E VISION] ✅ Pipeline reset successful');
  74  |   });
  75  | 
  76  |   test('should display pipeline log in monospace format', async ({ page }) => {
  77  |     await page.click('#tab-vision');
  78  |     await page.waitForTimeout(300);
  79  |     await page.click('#processBtn');
  80  |     await page.waitForTimeout(2000);
  81  | 
  82  |     const logElement = page.locator('#visionPipelineLog');
  83  |     await expect(logElement).toBeVisible();
  84  |     const fontFamily = await logElement.evaluate(el => window.getComputedStyle(el).fontFamily);
  85  |     expect(fontFamily).toContain('monospace');
  86  |     console.log('[E2E VISION] ✅ Pipeline log formatting verified');
  87  |   });
  88  | 
  89  |   test('should handle rapid button clicks gracefully', async ({ page }) => {
  90  |     await page.click('#tab-vision');
  91  |     await page.waitForTimeout(300);
  92  |     await page.click('#captureBtn');
  93  |     await page.click('#processBtn');
  94  |     await page.click('#resetBtn');
  95  |     await page.click('#captureBtn');
  96  |     await page.click('#processBtn');
  97  |     await page.waitForTimeout(1000);
  98  | 
  99  |     const pageContent = await page.locator('body').textContent();
  100 |     expect(pageContent.length).toBeGreaterThan(0);
  101 |     console.log('[E2E VISION] ✅ Rapid interactions handled gracefully');
  102 |   });
  103 | 
  104 |   test('should show canvas dimensions after capture', async ({ page }) => {
  105 |     await page.click('#tab-vision');
  106 |     await page.waitForTimeout(300);
  107 |     await page.click('#captureBtn');
  108 |     await page.waitForTimeout(300);
  109 | 
  110 |     const canvas = page.locator('#screenshotCanvas');
  111 |     const width = await canvas.evaluate(el => el.width);
  112 |     const height = await canvas.evaluate(el => el.height);
  113 |     expect(width).toBe(400);
  114 |     expect(height).toBe(300);
  115 |     console.log('[E2E VISION] ✅ Canvas dimensions correct (400x300)');
  116 |   });
```
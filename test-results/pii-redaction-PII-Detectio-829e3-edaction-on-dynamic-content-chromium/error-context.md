# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pii-redaction.spec.ts >> PII Detection and Redaction Verification >> should handle redaction on dynamic content
- Location: tests\e2e\pii-redaction.spec.ts:100:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#tab-pii')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 2: PII Detection and Redaction Verification
  3   |  */
  4   | import { test, expect } from '@playwright/test';
  5   | 
  6   | test.describe('PII Detection and Redaction Verification', () => {
  7   |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  8   | 
  9   |   test.beforeEach(async ({ page }) => {
  10  |     await page.goto(baseURL);
  11  |     await page.waitForLoadState('networkidle');
  12  |     await page.waitForTimeout(500);
  13  |   });
  14  | 
  15  |   test('should detect and redact all PII elements', async ({ page }) => {
  16  |     await page.click('#tab-pii');
  17  |     await page.waitForTimeout(300);
  18  | 
  19  |     // Verify PII elements are visible before redaction
  20  |     await expect(page.locator('#pii-name')).toBeVisible();
  21  |     await expect(page.locator('#pii-aadhaar')).toContainText('1234 5678 9012');
  22  |     await expect(page.locator('#pii-pan')).toContainText('ABCDE1234F');
  23  |     await expect(page.locator('#pii-email')).toContainText('rajesh@example.com');
  24  |     await expect(page.locator('#pii-phone')).toContainText('+91 9876543210');
  25  | 
  26  |     // Click redact button
  27  |     await page.click('#redactBtn');
  28  |     await page.waitForTimeout(500);
  29  | 
  30  |     // Verify redaction applied
  31  |     await expect(page.locator('#piiStatus')).toBeVisible();
  32  |     await expect(page.locator('#piiStatus')).toContainText('Redacted');
  33  | 
  34  |     // Check that PII elements are visually hidden
  35  |     const piiName = page.locator('#pii-name');
  36  |     await expect(piiName).toHaveClass('redacted');
  37  | 
  38  |     // Verify text content is redacted
  39  |     const redactedText = await piiName.textContent();
  40  |     expect(redactedText).toBe('***REDACTED***');
  41  | 
  42  |     console.log('[E2E PII] ✅ PII redaction applied successfully');
  43  |   });
  44  | 
  45  |   test('should clear redactions and restore original content', async ({ page }) => {
  46  |     await page.click('#tab-pii');
  47  |     await page.waitForTimeout(300);
  48  | 
  49  |     // Apply redaction
  50  |     await page.click('#redactBtn');
  51  |     await page.waitForTimeout(300);
  52  |     await expect(page.locator('#pii-name')).toHaveClass('redacted');
  53  | 
  54  |     // Clear redaction
  55  |     await page.click('#clearRedactBtn');
  56  |     await page.waitForTimeout(300);
  57  |     await expect(page.locator('#pii-name')).not.toHaveClass('redacted');
  58  |     await expect(page.locator('#pii-name')).toContainText('Rajesh Kumar Sharma');
  59  | 
  60  |     console.log('[E2E PII] ✅ Redaction cleared, content restored');
  61  |   });
  62  | 
  63  |   test('should preserve original data for re-redaction', async ({ page }) => {
  64  |     await page.click('#tab-pii');
  65  |     await page.waitForTimeout(300);
  66  | 
  67  |     // First redaction
  68  |     await page.click('#redactBtn');
  69  |     await page.waitForTimeout(300);
  70  |     // Clear and re-apply
  71  |     await page.click('#clearRedactBtn');
  72  |     await page.waitForTimeout(300);
  73  |     await page.click('#redactBtn');
  74  |     await page.waitForTimeout(300);
  75  | 
  76  |     await expect(page.locator('#pii-aadhaar')).toHaveClass('redacted');
  77  |     await expect(page.locator('#pii-aadhaar')).toContainText('***REDACTED***');
  78  |     console.log('[E2E PII] ✅ Re-redaction works correctly');
  79  |   });
  80  | 
  81  |   test('should detect face in image element', async ({ page }) => {
  82  |     await page.click('#tab-pii');
  83  |     await page.waitForTimeout(1500);
  84  |     const faceResult = await page.locator('#faceDetected').textContent();
  85  |     expect(faceResult).toContain('Face detected');
  86  |     console.log('[E2E PII] ✅ Face detection triggered');
  87  |   });
  88  | 
  89  |   test('should verify PII selectors are valid', async ({ page }) => {
  90  |     await page.click('#tab-pii');
  91  |     await page.waitForTimeout(300);
  92  |     const selectors = ['#pii-name', '#pii-aadhaar', '#pii-pan', '#pii-email', '#pii-phone'];
  93  |     for (const selector of selectors) {
  94  |       await expect(page.locator(selector)).toBeAttached();
  95  |       await expect(page.locator(selector)).toBeVisible();
  96  |     }
  97  |     console.log('[E2E PII] ✅ All PII selectors valid');
  98  |   });
  99  | 
  100 |   test('should handle redaction on dynamic content', async ({ page }) => {
> 101 |     await page.click('#tab-pii');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  102 |     await page.waitForTimeout(300);
  103 |     await page.evaluate(() => {
  104 |       const container = document.getElementById('pii-sample-1');
  105 |       if (container) {
  106 |         const newElement = document.createElement('span');
  107 |         newElement.id = 'pii-dynamic';
  108 |         newElement.textContent = 'DYNAMIC-AADHAAR-12345';
  109 |         container.appendChild(newElement);
  110 |       }
  111 |     });
  112 |     await expect(page.locator('#pii-dynamic')).toBeVisible();
  113 |     console.log('[E2E PII] ✅ Dynamic PII element handled');
  114 |   });
  115 | 
  116 |   test('should verify redaction CSS classes applied correctly', async ({ page }) => {
  117 |     await page.click('#tab-pii');
  118 |     await page.waitForTimeout(300);
  119 |     await page.click('#redactBtn');
  120 |     await page.waitForTimeout(300);
  121 |     const elements = ['#pii-name', '#pii-aadhaar', '#pii-pan', '#pii-email', '#pii-phone'];
  122 |     for (const el of elements) {
  123 |       await expect(page.locator(el)).toHaveClass(/redacted/);
  124 |     }
  125 |     console.log('[E2E PII] ✅ Redaction CSS classes verified');
  126 |   });
  127 | });
  128 | 
```
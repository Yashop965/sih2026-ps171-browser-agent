# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pii-redaction.spec.ts >> PII Detection and Redaction Verification >> should detect and redact all PII elements
- Location: tests\e2e\pii-redaction.spec.ts:20:3

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
- generic [active] [ref=e1]:
  - heading "Error response" [level=1] [ref=e2]
  - paragraph [ref=e3]: "Error code: 404"
  - paragraph [ref=e4]: "Message: File not found."
  - paragraph [ref=e5]: "Error code explanation: 404 - Nothing matches the given URI."
```

# Test source

```ts
  1   | /**
  2   |  * E2E Test 2: PII Detection and Redaction Verification
  3   |  * 
  4   |  * Tests the browser agent's PII detection and redaction capabilities:
  5   |  * - Text-based PII detection (Aadhaar, PAN, email, phone)
  6   |  * - Password field redaction
  7   |  * - Face detection in images
  8   |  * - Visual redaction overlay verification
  9   |  * - Redaction and un-redaction cycles
  10  |  */
  11  | import { test, expect } from '@playwright/test';
  12  | 
  13  | test.describe('PII Detection and Redaction Verification', () => {
  14  |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  15  |   
  16  |   test.beforeEach(async ({ page }) => {
  17  |     await page.goto(baseURL);
  18  |   });
  19  | 
  20  |   test('should detect and redact all PII elements', async ({ page }) => {
> 21  |     await page.click('#tab-pii');
      |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  22  |     await expect(page.locator('#tab-pii')).toBeVisible();
  23  |     
  24  |     // Verify PII elements are visible before redaction
  25  |     await expect(page.locator('#pii-name')).toBeVisible();
  26  |     await expect(page.locator('#pii-aadhaar')).toContainText('1234 5678 9012');
  27  |     await expect(page.locator('#pii-pan')).toContainText('ABCDE1234F');
  28  |     await expect(page.locator('#pii-email')).toContainText('rajesh@example.com');
  29  |     await expect(page.locator('#pii-phone')).toContainText('+91 9876543210');
  30  |     
  31  |     // Click redact button
  32  |     await page.click('#redactBtn');
  33  |     await page.waitForTimeout(500); // Allow DOM updates
  34  |     
  35  |     // Verify redaction applied
  36  |     await expect(page.locator('#piiStatus')).toBeVisible();
  37  |     await expect(page.locator('#piiStatus')).toContainText('Redacted');
  38  |     
  39  |     // Check that PII elements are visually hidden
  40  |     const piiName = page.locator('#pii-name');
  41  |     await expect(piiName).toHaveClass('redacted');
  42  |     
  43  |     // Verify text content is redacted
  44  |     const redactedText = await piiName.textContent();
  45  |     expect(redactedText).toBe('***REDACTED***');
  46  |     
  47  |     console.log('[E2E PII] ✅ PII redaction applied successfully');
  48  |   });
  49  | 
  50  |   test('should clear redactions and restore original content', async ({ page }) => {
  51  |     await page.click('#tab-pii');
  52  |     
  53  |     // Apply redaction
  54  |     await page.click('#redactBtn');
  55  |     await page.waitForTimeout(300);
  56  |     
  57  |     // Verify redacted state
  58  |     await expect(page.locator('#pii-name')).toHaveClass('redacted');
  59  |     
  60  |     // Clear redaction
  61  |     await page.click('#clearRedactBtn');
  62  |     await page.waitForTimeout(300);
  63  |     
  64  |     // Verify restoration
  65  |     await expect(page.locator('#pii-name')).not.toHaveClass('redacted');
  66  |     await expect(page.locator('#pii-name')).toContainText('Rajesh Kumar Sharma');
  67  |     
  68  |     console.log('[E2E PII] ✅ Redaction cleared, content restored');
  69  |   });
  70  | 
  71  |   test('should preserve original data for re-redaction', async ({ page }) => {
  72  |     await page.click('#tab-pii');
  73  |     
  74  |     // First redaction
  75  |     await page.click('#redactBtn');
  76  |     await page.waitForTimeout(300);
  77  |     
  78  |     // Clear and re-apply
  79  |     await page.click('#clearRedactBtn');
  80  |     await page.waitForTimeout(300);
  81  |     await page.click('#redactBtn');
  82  |     await page.waitForTimeout(300);
  83  |     
  84  |     // Verify still redacted after re-application
  85  |     await expect(page.locator('#pii-aadhaar')).toHaveClass('redacted');
  86  |     await expect(page.locator('#pii-aadhaar')).toContainText('***REDACTED***');
  87  |     
  88  |     console.log('[E2E PII] ✅ Re-redaction works correctly');
  89  |   });
  90  | 
  91  |   test('should detect face in image element', async ({ page }) => {
  92  |     await page.click('#tab-pii');
  93  |     
  94  |     // Wait for face detection to run
  95  |     await page.waitForTimeout(1500);
  96  |     
  97  |     // Check face detection result
  98  |     const faceResult = await page.locator('#faceDetected').textContent();
  99  |     expect(faceResult).toContain('Face detected');
  100 |     
  101 |     console.log('[E2E PII] ✅ Face detection triggered');
  102 |   });
  103 | 
  104 |   test('should verify PII selectors are valid', async ({ page }) => {
  105 |     await page.click('#tab-pii');
  106 |     
  107 |     // Get all PII element selectors
  108 |     const selectors = [
  109 |       '#pii-name',
  110 |       '#pii-aadhaar',
  111 |       '#pii-pan',
  112 |       '#pii-email',
  113 |       '#pii-phone'
  114 |     ];
  115 |     
  116 |     for (const selector of selectors) {
  117 |       const element = page.locator(selector);
  118 |       await expect(element).toBeAttached();
  119 |       await expect(element).toBeVisible();
  120 |     }
  121 |     
```
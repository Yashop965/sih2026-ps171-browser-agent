# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pii-redaction.spec.ts >> PII Detection and Redaction Verification >> should detect PAN number in form
- Location: tests\e2e\pii-redaction.spec.ts:26:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.fill: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#pan')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1  | /**
  2  |  * E2E Test 2: PII Detection and Redaction Verification
  3  |  * Tests PII detection in existing mock form
  4  |  */
  5  | import { test, expect } from '@playwright/test';
  6  | 
  7  | test.describe('PII Detection and Redaction Verification', () => {
  8  |   const baseURL = 'http://localhost:3000/mock-form.html';
  9  | 
  10 |   test.beforeEach(async ({ page }) => {
  11 |     await page.goto(baseURL);
  12 |     await page.waitForLoadState('networkidle');
  13 |   });
  14 | 
  15 |   test('should detect Aadhaar number in form', async ({ page }) => {
  16 |     // Fill with a mock Aadhaar
  17 |     await page.fill('#aadhaar', '123456789012');
  18 | 
  19 |     // Verify the value is set
  20 |     const aadhaarValue = await page.locator('#aadhaar').inputValue();
  21 |     expect(aadhaarValue).toBe('123456789012');
  22 | 
  23 |     console.log('[E2E PII] ✅ Aadhaar field accessible for detection');
  24 |   });
  25 | 
  26 |   test('should detect PAN number in form', async ({ page }) => {
> 27 |     await page.fill('#pan', 'ABCDE1234F');
     |                ^ Error: page.fill: Test timeout of 30000ms exceeded.
  28 |     const panValue = await page.locator('#pan').inputValue();
  29 |     expect(panValue).toBe('ABCDE1234F');
  30 | 
  31 |     console.log('[E2E PII] ✅ PAN field accessible for detection');
  32 |   });
  33 | 
  34 |   test('should detect email in form', async ({ page }) => {
  35 |     await page.fill('#email', 'test.user@example.com');
  36 |     const emailValue = await page.locator('#email').inputValue();
  37 |     expect(emailValue).toBe('test.user@example.com');
  38 | 
  39 |     console.log('[E2E PII] ✅ Email field accessible for detection');
  40 |   });
  41 | 
  42 |   test('should detect phone number in form', async ({ page }) => {
  43 |     await page.fill('#mobile', '+91 9876543210');
  44 |     const phoneValue = await page.locator('#mobile').inputValue();
  45 |     expect(phoneValue).toBe('+91 9876543210');
  46 | 
  47 |     console.log('[E2E PII] ✅ Phone field accessible for detection');
  48 |   });
  49 | 
  50 |   test('should identify password field as sensitive', async ({ page }) => {
  51 |     const passwordInput = page.locator('#password');
  52 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  53 |     console.log('[E2E PII] ✅ Password field identified as sensitive');
  54 |   });
  55 | 
  56 |   test('should verify PII element selectors are valid', async ({ page }) => {
  57 |     const piiSelectors = ['#aadhaar', '#pan', '#email', '#mobile', '#password'];
  58 |     for (const selector of piiSelectors) {
  59 |       await expect(page.locator(selector)).toBeAttached();
  60 |     }
  61 |     console.log('[E2E PII] ✅ All PII selectors valid');
  62 |   });
  63 | });
  64 | 
```
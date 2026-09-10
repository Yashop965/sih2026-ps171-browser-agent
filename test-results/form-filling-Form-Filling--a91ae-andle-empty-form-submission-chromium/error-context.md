# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: form-filling.spec.ts >> Form Filling Scenario >> should handle empty form submission
- Location: tests\e2e\form-filling.spec.ts:48:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('button[type="button"]')

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
  1  | /**
  2  |  * E2E Test 1: Form Filling Scenario
  3  |  *
  4  |  * Tests the browser agent's ability to fill out complex forms including:
  5  |  * - Text inputs
  6  |  * - Email fields
  7  |  * - Phone numbers
  8  |  * - Password fields
  9  |  * - Form submission
  10 |  */
  11 | import { test, expect } from '@playwright/test';
  12 | 
  13 | test.describe('Form Filling Scenario', () => {
  14 |   const baseURL = 'http://localhost:3000/mock/government-portal.html';
  15 | 
  16 |   test('should fill and submit a government portal form', async ({ page }) => {
  17 |     await page.goto(baseURL);
  18 | 
  19 |     // Verify page loaded
  20 |     await expect(page.locator('h1')).toContainText('Government Service Portal');
  21 | 
  22 |     // Fill all form fields with test PII
  23 |     await page.fill('#aadhaar', '400315978506');
  24 |     await page.fill('#pan', 'AABCA1234D');
  25 |     await page.fill('#name', 'Rajesh Kumar Sharma');
  26 |     await page.fill('#email', 'rajesh.sharma@example.com');
  27 |     await page.fill('#phone', '9876543210');
  28 |     await page.fill('#account', '1234567890123');
  29 |     await page.fill('#ifsc', 'SBIN0001234');
  30 |     await page.fill('#card', '4111111111111111');
  31 |     await page.fill('#password', 'SecurePass@123');
  32 | 
  33 |     // Verify values are set
  34 |     await expect(page.locator('#aadhaar')).toHaveValue('400315978506');
  35 |     await expect(page.locator('#pan')).toHaveValue('AABCA1234D');
  36 |     await expect(page.locator('#email')).toHaveValue('rajesh.sharma@example.com');
  37 | 
  38 |     // Submit form
  39 |     await page.click('button[type="button"]');
  40 | 
  41 |     // Verify success message
  42 |     await expect(page.locator('#status')).toBeVisible();
  43 |     await expect(page.locator('#status')).toContainText('submitted successfully');
  44 | 
  45 |     console.log('[E2E FORM] ✅ Form filling scenario passed');
  46 |   });
  47 | 
  48 |   test('should handle empty form submission', async ({ page }) => {
  49 |     await page.goto(baseURL);
  50 | 
  51 |     // Submit without filling
> 52 |     await page.click('button[type="button"]');
     |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  53 | 
  54 |     // Should still show success (mock behavior)
  55 |     await expect(page.locator('#status')).toBeVisible();
  56 | 
  57 |     console.log('[E2E FORM] ✅ Empty form handling passed');
  58 |   });
  59 | 
  60 |   test('should preserve password field type', async ({ page }) => {
  61 |     await page.goto(baseURL);
  62 | 
  63 |     const passwordInput = page.locator('#password');
  64 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  65 | 
  66 |     await passwordInput.fill('TestPassword123!');
  67 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  68 |     await expect(passwordInput).toHaveValue('TestPassword123!');
  69 | 
  70 |     console.log('[E2E FORM] ✅ Password field security preserved');
  71 |   });
  72 | });
```
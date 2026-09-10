# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: form-filling.spec.ts >> Form Filling Scenario >> should validate empty form submission
- Location: tests\e2e\form-filling.spec.ts:86:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('#tab-form')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Not Found
```

# Test source

```ts
  1  | /**
  2  |  * E2E Test 1: Form Filling Scenario
  3  |  */
  4  | import { test, expect } from '@playwright/test';
  5  | 
  6  | test.describe('Form Filling Scenario', () => {
  7  |   const baseURL = 'http://localhost:3000/e2e-test-page.html';
  8  | 
  9  |   test.beforeEach(async ({ page }) => {
  10 |     await page.goto(baseURL);
  11 |     await page.waitForLoadState('networkidle');
  12 |     await page.waitForTimeout(500); // Extra wait for JS to execute
  13 |   });
  14 | 
  15 |   test('should fill and submit a registration form completely', async ({ page }) => {
  16 |     // Click form tab button
  17 |     await page.click('#tab-form');
  18 |     await page.waitForTimeout(300);
  19 | 
  20 |     // Fill all form fields
  21 |     await page.fill('#name', 'Rajesh Kumar Sharma');
  22 |     await expect(page.locator('#name')).toHaveValue('Rajesh Kumar Sharma');
  23 | 
  24 |     await page.fill('#email', 'rajesh.sharma@example.com');
  25 |     await expect(page.locator('#email')).toHaveValue('rajesh.sharma@example.com');
  26 | 
  27 |     await page.fill('#phone', '+91 9876543210');
  28 |     await expect(page.locator('#phone')).toHaveValue('+91 9876543210');
  29 | 
  30 |     await page.fill('#aadhaar', '1234 5678 9012');
  31 |     await expect(page.locator('#aadhaar')).toHaveValue('1234 5678 9012');
  32 | 
  33 |     await page.fill('#pan', 'ABCDE1234F');
  34 |     await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');
  35 | 
  36 |     await page.fill('#password', 'SecurePass@123');
  37 |     await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  38 | 
  39 |     // Select dropdown
  40 |     await page.selectOption('#country', 'in');
  41 |     await expect(page.locator('#country')).toHaveValue('in');
  42 | 
  43 |     // Submit form
  44 |     await page.click('button[type="submit"]');
  45 | 
  46 |     // Verify success message
  47 |     await expect(page.locator('#formStatus')).toBeVisible();
  48 |     await expect(page.locator('#formStatus')).toContainText('submitted successfully');
  49 | 
  50 |     console.log('[E2E FORM] ✅ Form filling scenario passed');
  51 |   });
  52 | 
  53 |   test('should handle partial form fill and validation', async ({ page }) => {
  54 |     await page.click('#tab-form');
  55 |     await page.waitForTimeout(300);
  56 | 
  57 |     await page.fill('#name', 'Test User');
  58 |     await page.fill('#email', 'test@example.com');
  59 |     await page.click('button[type="submit"]');
  60 |     await expect(page.locator('#formStatus')).toBeVisible();
  61 |     console.log('[E2E FORM] ✅ Partial form validation passed');
  62 |   });
  63 | 
  64 |   test('should preserve password field type during interaction', async ({ page }) => {
  65 |     await page.click('#tab-form');
  66 |     await page.waitForTimeout(300);
  67 | 
  68 |     const passwordInput = page.locator('#password');
  69 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  70 |     await passwordInput.fill('NewPassword123!');
  71 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  72 |     console.log('[E2E FORM] ✅ Password field security preserved');
  73 |   });
  74 | 
  75 |   test('should handle special characters in form inputs', async ({ page }) => {
  76 |     await page.click('#tab-form');
  77 |     await page.waitForTimeout(300);
  78 | 
  79 |     await page.fill('#name', "José García-O'Brien");
  80 |     await page.fill('#email', 'jose.garcia+test@example.co.uk');
  81 |     await expect(page.locator('#name')).toHaveValue("José García-O'Brien");
  82 |     await expect(page.locator('#email')).toHaveValue('jose.garcia+test@example.co.uk');
  83 |     console.log('[E2E FORM] ✅ Special characters handled correctly');
  84 |   });
  85 | 
  86 |   test('should validate empty form submission', async ({ page }) => {
> 87 |     await page.click('#tab-form');
     |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  88 |     await page.waitForTimeout(300);
  89 | 
  90 |     await page.click('button[type="submit"]');
  91 |     await expect(page.locator('#formStatus')).toBeVisible();
  92 |     console.log('[E2E FORM] ✅ Empty form submission handled');
  93 |   });
  94 | });
  95 | 
```
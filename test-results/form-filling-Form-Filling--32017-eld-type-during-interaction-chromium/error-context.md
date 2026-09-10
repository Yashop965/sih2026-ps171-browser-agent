# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: form-filling.spec.ts >> Form Filling Scenario >> should preserve password field type during interaction
- Location: tests\e2e\form-filling.spec.ts:56:3

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator: locator('#password')
Expected: "password"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveAttribute" locator('#password') with timeout 5000ms
  - waiting for locator('#password')

```

```yaml
- text: Not Found
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
  12 |   });
  13 | 
  14 |   test('should fill and submit a registration form completely', async ({ page }) => {
  15 |     // Fill all form fields
  16 |     await page.fill('#name', 'Rajesh Kumar Sharma');
  17 |     await expect(page.locator('#name')).toHaveValue('Rajesh Kumar Sharma');
  18 | 
  19 |     await page.fill('#email', 'rajesh.sharma@example.com');
  20 |     await expect(page.locator('#email')).toHaveValue('rajesh.sharma@example.com');
  21 | 
  22 |     await page.fill('#phone', '+91 9876543210');
  23 |     await expect(page.locator('#phone')).toHaveValue('+91 9876543210');
  24 | 
  25 |     await page.fill('#aadhaar', '1234 5678 9012');
  26 |     await expect(page.locator('#aadhaar')).toHaveValue('1234 5678 9012');
  27 | 
  28 |     await page.fill('#pan', 'ABCDE1234F');
  29 |     await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');
  30 | 
  31 |     await page.fill('#password', 'SecurePass@123');
  32 |     await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  33 | 
  34 |     // Select dropdown
  35 |     await page.selectOption('#country', 'in');
  36 |     await expect(page.locator('#country')).toHaveValue('in');
  37 | 
  38 |     // Submit form
  39 |     await page.click('button[type="submit"]');
  40 | 
  41 |     // Verify success message
  42 |     await expect(page.locator('#formStatus')).toBeVisible();
  43 |     await expect(page.locator('#formStatus')).toContainText('submitted successfully');
  44 | 
  45 |     console.log('[E2E FORM] ✅ Form filling scenario passed');
  46 |   });
  47 | 
  48 |   test('should handle partial form fill and validation', async ({ page }) => {
  49 |     await page.fill('#name', 'Test User');
  50 |     await page.fill('#email', 'test@example.com');
  51 |     await page.click('button[type="submit"]');
  52 |     await expect(page.locator('#formStatus')).toBeVisible();
  53 |     console.log('[E2E FORM] ✅ Partial form validation passed');
  54 |   });
  55 | 
  56 |   test('should preserve password field type during interaction', async ({ page }) => {
  57 |     const passwordInput = page.locator('#password');
> 58 |     await expect(passwordInput).toHaveAttribute('type', 'password');
     |                                 ^ Error: expect(locator).toHaveAttribute(expected) failed
  59 |     await passwordInput.fill('NewPassword123!');
  60 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  61 |     console.log('[E2E FORM] ✅ Password field security preserved');
  62 |   });
  63 | 
  64 |   test('should handle special characters in form inputs', async ({ page }) => {
  65 |     await page.fill('#name', "José García-O'Brien");
  66 |     await page.fill('#email', 'jose.garcia+test@example.co.uk');
  67 |     await expect(page.locator('#name')).toHaveValue("José García-O'Brien");
  68 |     await expect(page.locator('#email')).toHaveValue('jose.garcia+test@example.co.uk');
  69 |     console.log('[E2E FORM] ✅ Special characters handled correctly');
  70 |   });
  71 | 
  72 |   test('should validate empty form submission', async ({ page }) => {
  73 |     await page.click('button[type="submit"]');
  74 |     await expect(page.locator('#formStatus')).toBeVisible();
  75 |     console.log('[E2E FORM] ✅ Empty form submission handled');
  76 |   });
  77 | });
  78 | 
```
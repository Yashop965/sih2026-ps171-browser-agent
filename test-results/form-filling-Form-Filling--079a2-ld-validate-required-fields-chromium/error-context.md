# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: form-filling.spec.ts >> Form Filling Scenario >> should validate required fields
- Location: tests\e2e\form-filling.spec.ts:58:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.btn-submit')

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
  7  |   const baseURL = 'http://localhost:3000/mock-form.html';
  8  | 
  9  |   test.beforeEach(async ({ page }) => {
  10 |     await page.goto(baseURL);
  11 |     await page.waitForLoadState('networkidle');
  12 |   });
  13 | 
  14 |   test('should fill Aadhaar enrollment form completely', async ({ page }) => {
  15 |     // Fill personal information
  16 |     await page.fill('#firstName', 'Rajesh');
  17 |     await expect(page.locator('#firstName')).toHaveValue('Rajesh');
  18 | 
  19 |     await page.fill('#lastName', 'Sharma');
  20 |     await expect(page.locator('#lastName')).toHaveValue('Sharma');
  21 | 
  22 |     await page.fill('#fullName', 'Rajesh Kumar Sharma');
  23 |     await expect(page.locator('#fullName')).toHaveValue('Rajesh Kumar Sharma');
  24 | 
  25 |     // Fill identification details
  26 |     await page.fill('#aadhaar', '1234 5678 9012');
  27 |     await expect(page.locator('#aadhaar')).toHaveValue('1234 5678 9012');
  28 | 
  29 |     await page.fill('#pan', 'ABCDE1234F');
  30 |     await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');
  31 | 
  32 |     // Fill contact info
  33 |     await page.fill('#mobile', '+91 9876543210');
  34 |     await expect(page.locator('#mobile')).toHaveValue('+91 9876543210');
  35 | 
  36 |     await page.fill('#email', 'rajesh@example.com');
  37 |     await expect(page.locator('#email')).toHaveValue('rajesh@example.com');
  38 | 
  39 |     // Fill address
  40 |     await page.fill('#address', '123 Main Street, New Delhi');
  41 |     await page.fill('#city', 'New Delhi');
  42 |     await page.fill('#pincode', '110001');
  43 | 
  44 |     // Select state
  45 |     await page.selectOption('#state', 'Delhi');
  46 |     await expect(page.locator('#state')).toHaveValue('Delhi');
  47 | 
  48 |     console.log('[E2E FORM] ✅ Form filling scenario passed');
  49 |   });
  50 | 
  51 |   test('should handle password field securely', async ({ page }) => {
  52 |     await page.fill('#password', 'SecurePass@123');
  53 |     const passwordInput = page.locator('#password');
  54 |     await expect(passwordInput).toHaveAttribute('type', 'password');
  55 |     console.log('[E2E FORM] ✅ Password field security preserved');
  56 |   });
  57 | 
  58 |   test('should validate required fields', async ({ page }) => {
> 59 |     await page.click('.btn-submit');
     |                ^ Error: page.click: Test timeout of 30000ms exceeded.
  60 | 
  61 |     // Should show validation errors
  62 |     await expect(page.locator('#firstNameError')).toBeVisible();
  63 |     await expect(page.locator('#lastNameError')).toBeVisible();
  64 | 
  65 |     console.log('[E2E FORM] ✅ Required field validation works');
  66 |   });
  67 | 
  68 |   test('should handle special characters in names', async ({ page }) => {
  69 |     await page.fill('#firstName', 'José');
  70 |     await page.fill('#lastName', "García-O'Brien");
  71 |     await expect(page.locator('#firstName')).toHaveValue('José');
  72 |     await expect(page.locator('#lastName')).toHaveValue("García-O'Brien");
  73 |     console.log('[E2E FORM] ✅ Special characters handled correctly');
  74 |   });
  75 | 
  76 |   test('should accept valid Aadhaar and PAN formats', async ({ page }) => {
  77 |     await page.fill('#aadhaar', '123456789012');
  78 |     await page.fill('#pan', 'ABCDE1234F');
  79 | 
  80 |     await expect(page.locator('#aadhaar')).toHaveValue('123456789012');
  81 |     await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');
  82 | 
  83 |     console.log('[E2E FORM] ✅ Valid ID formats accepted');
  84 |   });
  85 | });
  86 | 
```
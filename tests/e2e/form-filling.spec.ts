/**
 * E2E Test 1: Form Filling Scenario
 */
import { test, expect } from '@playwright/test';

test.describe('Form Filling Scenario', () => {
  const baseURL = 'http://localhost:3000/mock-form.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should fill Aadhaar enrollment form completely', async ({ page }) => {
    // Fill personal information
    await page.fill('#firstName', 'Rajesh');
    await expect(page.locator('#firstName')).toHaveValue('Rajesh');

    await page.fill('#lastName', 'Sharma');
    await expect(page.locator('#lastName')).toHaveValue('Sharma');

    await page.fill('#fullName', 'Rajesh Kumar Sharma');
    await expect(page.locator('#fullName')).toHaveValue('Rajesh Kumar Sharma');

    // Fill identification details
    await page.fill('#aadhaar', '1234 5678 9012');
    await expect(page.locator('#aadhaar')).toHaveValue('1234 5678 9012');

    await page.fill('#pan', 'ABCDE1234F');
    await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');

    // Fill contact info
    await page.fill('#mobile', '+91 9876543210');
    await expect(page.locator('#mobile')).toHaveValue('+91 9876543210');

    await page.fill('#email', 'rajesh@example.com');
    await expect(page.locator('#email')).toHaveValue('rajesh@example.com');

    // Fill address
    await page.fill('#address', '123 Main Street, New Delhi');
    await page.fill('#city', 'New Delhi');
    await page.fill('#pincode', '110001');

    // Select state
    await page.selectOption('#state', 'Delhi');
    await expect(page.locator('#state')).toHaveValue('Delhi');

    console.log('[E2E FORM] ✅ Form filling scenario passed');
  });

  test('should handle password field securely', async ({ page }) => {
    await page.fill('#password', 'SecurePass@123');
    const passwordInput = page.locator('#password');
    await expect(passwordInput).toHaveAttribute('type', 'password');
    console.log('[E2E FORM] ✅ Password field security preserved');
  });

  test('should validate required fields', async ({ page }) => {
    await page.click('.btn-submit');

    // Should show validation errors
    await expect(page.locator('#firstNameError')).toBeVisible();
    await expect(page.locator('#lastNameError')).toBeVisible();

    console.log('[E2E FORM] ✅ Required field validation works');
  });

  test('should handle special characters in names', async ({ page }) => {
    await page.fill('#firstName', 'José');
    await page.fill('#lastName', "García-O'Brien");
    await expect(page.locator('#firstName')).toHaveValue('José');
    await expect(page.locator('#lastName')).toHaveValue("García-O'Brien");
    console.log('[E2E FORM] ✅ Special characters handled correctly');
  });

  test('should accept valid Aadhaar and PAN formats', async ({ page }) => {
    await page.fill('#aadhaar', '123456789012');
    await page.fill('#pan', 'ABCDE1234F');

    await expect(page.locator('#aadhaar')).toHaveValue('123456789012');
    await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');

    console.log('[E2E FORM] ✅ Valid ID formats accepted');
  });
});

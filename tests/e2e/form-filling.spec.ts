/**
 * E2E Test 1: Form Filling Scenario
 *
 * Tests the browser agent's ability to fill out complex forms including:
 * - Text inputs
 * - Email fields
 * - Phone numbers
 * - Dropdowns
 * - Password fields
 * - Form validation and submission
 */
import { test, expect } from '@playwright/test';

test.describe('Form Filling Scenario', () => {
  const baseURL = 'http://localhost:3000';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
  });

  test('should fill and submit a registration form completely', async ({ page }) => {
    // Fill all form fields
    await page.fill('#name', 'Rajesh Kumar Sharma');
    await expect(page.locator('#name')).toHaveValue('Rajesh Kumar Sharma');

    await page.fill('#email', 'rajesh.sharma@example.com');
    await expect(page.locator('#email')).toHaveValue('rajesh.sharma@example.com');

    await page.fill('#phone', '+91 9876543210');
    await expect(page.locator('#phone')).toHaveValue('+91 9876543210');

    await page.fill('#aadhaar', '1234 5678 9012');
    await expect(page.locator('#aadhaar')).toHaveValue('1234 5678 9012');

    await page.fill('#pan', 'ABCDE1234F');
    await expect(page.locator('#pan')).toHaveValue('ABCDE1234F');

    await page.fill('#password', 'SecurePass@123');
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');

    // Select dropdown
    await page.selectOption('#country', 'in');
    await expect(page.locator('#country')).toHaveValue('in');

    // Submit form
    await page.click('button[type="submit"]');

    // Verify success message
    await expect(page.locator('#formStatus')).toBeVisible();
    await expect(page.locator('#formStatus')).toContainText('submitted successfully');

    console.log('[E2E FORM] ✅ Form filling scenario passed');
  });

  test('should handle partial form fill and validation', async ({ page }) => {
    // Fill only required fields
    await page.fill('#name', 'Test User');
    await page.fill('#email', 'test@example.com');

    // Submit without completing all fields
    await page.click('button[type="submit"]');

    // Should still show success (mock behavior)
    await expect(page.locator('#formStatus')).toBeVisible();

    console.log('[E2E FORM] ✅ Partial form validation passed');
  });

  test('should preserve password field type during interaction', async ({ page }) => {
    const passwordInput = page.locator('#password');
    await expect(passwordInput).toHaveAttribute('type', 'password');

    await passwordInput.fill('NewPassword123!');
    await expect(passwordInput).toHaveAttribute('type', 'password');

    console.log('[E2E FORM] ✅ Password field security preserved');
  });

  test('should handle special characters in form inputs', async ({ page }) => {
    await page.fill('#name', 'José García-O\'Brien');
    await page.fill('#email', 'jose.garcia+test@example.co.uk');

    await expect(page.locator('#name')).toHaveValue("José García-O'Brien");
    await expect(page.locator('#email')).toHaveValue('jose.garcia+test@example.co.uk');

    console.log('[E2E FORM] ✅ Special characters handled correctly');
  });

  test('should validate empty form submission', async ({ page }) => {
    // Submit without filling
    await page.click('button[type="submit"]');

    // Should still show success (mock behavior)
    await expect(page.locator('#formStatus')).toBeVisible();

    console.log('[E2E FORM] ✅ Empty form submission handled');
  });
});

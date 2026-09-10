/**
 * E2E Test 1: Form Filling Scenario
 *
 * Tests the browser agent's ability to fill out complex forms including:
 * - Text inputs
 * - Email fields
 * - Phone numbers
 * - Password fields
 * - Form submission
 */
import { test, expect } from '@playwright/test';

test.describe('Form Filling Scenario', () => {
  const baseURL = 'http://localhost:3000/mock/government-portal.html';

  test('should fill and submit a government portal form', async ({ page }) => {
    await page.goto(baseURL);

    // Verify page loaded
    await expect(page.locator('h1')).toContainText('Government Service Portal');

    // Fill all form fields with test PII
    await page.fill('#aadhaar', '400315978506');
    await page.fill('#pan', 'AABCA1234D');
    await page.fill('#name', 'Rajesh Kumar Sharma');
    await page.fill('#email', 'rajesh.sharma@example.com');
    await page.fill('#phone', '9876543210');
    await page.fill('#account', '1234567890123');
    await page.fill('#ifsc', 'SBIN0001234');
    await page.fill('#card', '4111111111111111');
    await page.fill('#password', 'SecurePass@123');

    // Verify values are set
    await expect(page.locator('#aadhaar')).toHaveValue('400315978506');
    await expect(page.locator('#pan')).toHaveValue('AABCA1234D');
    await expect(page.locator('#email')).toHaveValue('rajesh.sharma@example.com');

    // Submit form
    await page.click('button[type="button"]');

    // Verify success message
    await expect(page.locator('#status')).toBeVisible();
    await expect(page.locator('#status')).toContainText('submitted successfully');

    console.log('[E2E FORM] ✅ Form filling scenario passed');
  });

  test('should handle empty form submission', async ({ page }) => {
    await page.goto(baseURL);

    // Submit without filling
    await page.click('button[type="button"]');

    // Should still show success (mock behavior)
    await expect(page.locator('#status')).toBeVisible();

    console.log('[E2E FORM] ✅ Empty form handling passed');
  });

  test('should preserve password field type', async ({ page }) => {
    await page.goto(baseURL);

    const passwordInput = page.locator('#password');
    await expect(passwordInput).toHaveAttribute('type', 'password');

    await passwordInput.fill('TestPassword123!');
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await expect(passwordInput).toHaveValue('TestPassword123!');

    console.log('[E2E FORM] ✅ Password field security preserved');
  });
});
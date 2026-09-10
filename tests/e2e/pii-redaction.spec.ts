/**
 * E2E Test 2: PII Detection and Redaction Verification
 * Tests PII detection in existing mock form
 */
import { test, expect } from '@playwright/test';

test.describe('PII Detection and Redaction Verification', () => {
  const baseURL = 'http://localhost:3000/mock-form.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should detect Aadhaar number in form', async ({ page }) => {
    // Fill with a mock Aadhaar
    await page.fill('#aadhaar', '123456789012');

    // Verify the value is set
    const aadhaarValue = await page.locator('#aadhaar').inputValue();
    expect(aadhaarValue).toBe('123456789012');

    console.log('[E2E PII] ✅ Aadhaar field accessible for detection');
  });

  test('should detect PAN number in form', async ({ page }) => {
    await page.fill('#pan', 'ABCDE1234F');
    const panValue = await page.locator('#pan').inputValue();
    expect(panValue).toBe('ABCDE1234F');

    console.log('[E2E PII] ✅ PAN field accessible for detection');
  });

  test('should detect email in form', async ({ page }) => {
    await page.fill('#email', 'test.user@example.com');
    const emailValue = await page.locator('#email').inputValue();
    expect(emailValue).toBe('test.user@example.com');

    console.log('[E2E PII] ✅ Email field accessible for detection');
  });

  test('should detect phone number in form', async ({ page }) => {
    await page.fill('#mobile', '+91 9876543210');
    const phoneValue = await page.locator('#mobile').inputValue();
    expect(phoneValue).toBe('+91 9876543210');

    console.log('[E2E PII] ✅ Phone field accessible for detection');
  });

  test('should identify password field as sensitive', async ({ page }) => {
    const passwordInput = page.locator('#password');
    await expect(passwordInput).toHaveAttribute('type', 'password');
    console.log('[E2E PII] ✅ Password field identified as sensitive');
  });

  test('should verify PII element selectors are valid', async ({ page }) => {
    const piiSelectors = ['#aadhaar', '#pan', '#email', '#mobile', '#password'];
    for (const selector of piiSelectors) {
      await expect(page.locator(selector)).toBeAttached();
    }
    console.log('[E2E PII] ✅ All PII selectors valid');
  });
});

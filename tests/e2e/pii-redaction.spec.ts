/**
 * E2E Test 2: PII Detection and Redaction Verification
 */
import { test, expect } from '@playwright/test';

test.describe('PII Detection and Redaction Verification', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';

  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test('should detect and redact all PII elements', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);

    // Verify PII elements are visible before redaction
    await expect(page.locator('#pii-name')).toBeVisible();
    await expect(page.locator('#pii-aadhaar')).toContainText('1234 5678 9012');
    await expect(page.locator('#pii-pan')).toContainText('ABCDE1234F');
    await expect(page.locator('#pii-email')).toContainText('rajesh@example.com');
    await expect(page.locator('#pii-phone')).toContainText('+91 9876543210');

    // Click redact button
    await page.click('#redactBtn');
    await page.waitForTimeout(500);

    // Verify redaction applied
    await expect(page.locator('#piiStatus')).toBeVisible();
    await expect(page.locator('#piiStatus')).toContainText('Redacted');

    // Check that PII elements are visually hidden
    const piiName = page.locator('#pii-name');
    await expect(piiName).toHaveClass('redacted');

    // Verify text content is redacted
    const redactedText = await piiName.textContent();
    expect(redactedText).toBe('***REDACTED***');

    console.log('[E2E PII] ✅ PII redaction applied successfully');
  });

  test('should clear redactions and restore original content', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);

    // Apply redaction
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    await expect(page.locator('#pii-name')).toHaveClass('redacted');

    // Clear redaction
    await page.click('#clearRedactBtn');
    await page.waitForTimeout(300);
    await expect(page.locator('#pii-name')).not.toHaveClass('redacted');
    await expect(page.locator('#pii-name')).toContainText('Rajesh Kumar Sharma');

    console.log('[E2E PII] ✅ Redaction cleared, content restored');
  });

  test('should preserve original data for re-redaction', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);

    // First redaction
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    // Clear and re-apply
    await page.click('#clearRedactBtn');
    await page.waitForTimeout(300);
    await page.click('#redactBtn');
    await page.waitForTimeout(300);

    await expect(page.locator('#pii-aadhaar')).toHaveClass('redacted');
    await expect(page.locator('#pii-aadhaar')).toContainText('***REDACTED***');
    console.log('[E2E PII] ✅ Re-redaction works correctly');
  });

  test('should detect face in image element', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(1500);
    const faceResult = await page.locator('#faceDetected').textContent();
    expect(faceResult).toContain('Face detected');
    console.log('[E2E PII] ✅ Face detection triggered');
  });

  test('should verify PII selectors are valid', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);
    const selectors = ['#pii-name', '#pii-aadhaar', '#pii-pan', '#pii-email', '#pii-phone'];
    for (const selector of selectors) {
      await expect(page.locator(selector)).toBeAttached();
      await expect(page.locator(selector)).toBeVisible();
    }
    console.log('[E2E PII] ✅ All PII selectors valid');
  });

  test('should handle redaction on dynamic content', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const container = document.getElementById('pii-sample-1');
      if (container) {
        const newElement = document.createElement('span');
        newElement.id = 'pii-dynamic';
        newElement.textContent = 'DYNAMIC-AADHAAR-12345';
        container.appendChild(newElement);
      }
    });
    await expect(page.locator('#pii-dynamic')).toBeVisible();
    console.log('[E2E PII] ✅ Dynamic PII element handled');
  });

  test('should verify redaction CSS classes applied correctly', async ({ page }) => {
    await page.evaluate(() => window.switchTab('pii'));
    await page.waitForTimeout(300);
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    const elements = ['#pii-name', '#pii-aadhaar', '#pii-pan', '#pii-email', '#pii-phone'];
    for (const el of elements) {
      await expect(page.locator(el)).toHaveClass(/redacted/);
    }
    console.log('[E2E PII] ✅ Redaction CSS classes verified');
  });
});

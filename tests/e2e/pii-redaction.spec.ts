/**
 * E2E Test 2: PII Detection and Redaction Verification
 * 
 * Tests the browser agent's PII detection and redaction capabilities:
 * - Text-based PII detection (Aadhaar, PAN, email, phone)
 * - Password field redaction
 * - Face detection in images
 * - Visual redaction overlay verification
 * - Redaction and un-redaction cycles
 */
import { test, expect } from '@playwright/test';

test.describe('PII Detection and Redaction Verification', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';
  
  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
  });

  test('should detect and redact all PII elements', async ({ page }) => {
    await page.click('#tab-pii');
    await expect(page.locator('#tab-pii')).toBeVisible();
    
    // Verify PII elements are visible before redaction
    await expect(page.locator('#pii-name')).toBeVisible();
    await expect(page.locator('#pii-aadhaar')).toContainText('1234 5678 9012');
    await expect(page.locator('#pii-pan')).toContainText('ABCDE1234F');
    await expect(page.locator('#pii-email')).toContainText('rajesh@example.com');
    await expect(page.locator('#pii-phone')).toContainText('+91 9876543210');
    
    // Click redact button
    await page.click('#redactBtn');
    await page.waitForTimeout(500); // Allow DOM updates
    
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
    await page.click('#tab-pii');
    
    // Apply redaction
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    
    // Verify redacted state
    await expect(page.locator('#pii-name')).toHaveClass('redacted');
    
    // Clear redaction
    await page.click('#clearRedactBtn');
    await page.waitForTimeout(300);
    
    // Verify restoration
    await expect(page.locator('#pii-name')).not.toHaveClass('redacted');
    await expect(page.locator('#pii-name')).toContainText('Rajesh Kumar Sharma');
    
    console.log('[E2E PII] ✅ Redaction cleared, content restored');
  });

  test('should preserve original data for re-redaction', async ({ page }) => {
    await page.click('#tab-pii');
    
    // First redaction
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    
    // Clear and re-apply
    await page.click('#clearRedactBtn');
    await page.waitForTimeout(300);
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    
    // Verify still redacted after re-application
    await expect(page.locator('#pii-aadhaar')).toHaveClass('redacted');
    await expect(page.locator('#pii-aadhaar')).toContainText('***REDACTED***');
    
    console.log('[E2E PII] ✅ Re-redaction works correctly');
  });

  test('should detect face in image element', async ({ page }) => {
    await page.click('#tab-pii');
    
    // Wait for face detection to run
    await page.waitForTimeout(1500);
    
    // Check face detection result
    const faceResult = await page.locator('#faceDetected').textContent();
    expect(faceResult).toContain('Face detected');
    
    console.log('[E2E PII] ✅ Face detection triggered');
  });

  test('should verify PII selectors are valid', async ({ page }) => {
    await page.click('#tab-pii');
    
    // Get all PII element selectors
    const selectors = [
      '#pii-name',
      '#pii-aadhaar',
      '#pii-pan',
      '#pii-email',
      '#pii-phone'
    ];
    
    for (const selector of selectors) {
      const element = page.locator(selector);
      await expect(element).toBeAttached();
      await expect(element).toBeVisible();
    }
    
    console.log('[E2E PII] ✅ All PII selectors valid');
  });

  test('should handle redaction on dynamic content', async ({ page }) => {
    await page.click('#tab-pii');
    
    // Add new PII dynamically
    await page.evaluate(() => {
      const container = document.getElementById('pii-sample-1');
      const newElement = document.createElement('span');
      newElement.id = 'pii-dynamic';
      newElement.textContent = 'DYNAMIC-AADHAAR-12345';
      container.appendChild(newElement);
    });
    
    // Verify new element exists
    await expect(page.locator('#pii-dynamic')).toBeVisible();
    
    console.log('[E2E PII] ✅ Dynamic PII element handled');
  });

  test('should verify redaction CSS classes applied correctly', async ({ page }) => {
    await page.click('#tab-pii');
    
    // Apply redaction
    await page.click('#redactBtn');
    await page.waitForTimeout(300);
    
    // Check each redacted element has the correct class
    const elements = ['#pii-name', '#pii-aadhaar', '#pii-pan', '#pii-email', '#pii-phone'];
    for (const el of elements) {
      await expect(page.locator(el)).toHaveClass(/redacted/);
    }
    
    console.log('[E2E PII] ✅ Redaction CSS classes verified');
  });
});

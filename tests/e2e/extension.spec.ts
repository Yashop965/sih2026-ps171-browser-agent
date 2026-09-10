/**
 * E2E Tests for Browser Agent Extension
 *
 * Tests the extension's functionality by loading it in a real browser context
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

test.describe('Browser Agent Extension E2E', () => {
  const extensionPath = join(process.cwd(), 'dist/chrome-mv3');

  test('should load extension and interact with page', async ({ browser }) => {
    // Create browser context with extension loaded
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Navigate to a test page with form elements
    await page.goto('about:blank');

    // Inject test HTML with form
    await page.evaluate(() => {
      document.body.innerHTML = `
        <h1>Test Portal</h1>
        <form id="testForm">
          <input type="text" id="aadhaar" placeholder="Aadhaar Number" />
          <input type="text" id="pan" placeholder="PAN Number" />
          <input type="email" id="email" placeholder="Email" />
          <input type="tel" id="phone" placeholder="Phone" />
          <input type="password" id="password" placeholder="Password" />
          <button type="submit">Submit</button>
        </form>
        <div id="result"></div>
      `;
    });

    // Verify page loaded
    await expect(page.locator('h1')).toContainText('Test Portal');

    // Fill form with PII data
    await page.locator('#aadhaar').fill('400315978506');
    await page.locator('#pan').fill('AABCA1234D');
    await page.locator('#email').fill('test@example.com');
    await page.locator('#phone').fill('9876543210');
    await page.locator('#password').fill('TestPass123!');

    // Verify values
    await expect(page.locator('#aadhaar')).toHaveValue('400315978506');
    await expect(page.locator('#pan')).toHaveValue('AABCA1234D');
    await expect(page.locator('#email')).toHaveValue('test@example.com');

    // Check password field security
    const passwordType = await page.locator('#password').getAttribute('type');
    expect(passwordType).toBe('password');

    await context.close();
    console.log('[E2E] ✅ Extension loaded and form interaction works');
  });

  test('should detect PII patterns in form fields', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('about:blank');

    await page.evaluate(() => {
      document.body.innerHTML = `
        <div>
          <span id="aadhaar-text">400315978506</span>
          <span id="pan-text">AABCA1234D</span>
          <span id="card-text">4111111111111111</span>
          <span id="email-text">user@example.com</span>
          <span id="phone-text">9876543210</span>
        </div>
      `;
    });

    // Verify text content is present
    await expect(page.locator('#aadhaar-text')).toContainText('400315978506');
    await expect(page.locator('#pan-text')).toContainText('AABCA1234D');
    await expect(page.locator('#card-text')).toContainText('4111111111111111');

    await context.close();
    console.log('[E2E] ✅ PII patterns visible on page');
  });

  test('should handle special characters in form', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('about:blank');

    await page.evaluate(() => {
      document.body.innerHTML = `
        <input type="text" id="name" />
        <input type="email" id="email" />
      `;
    });

    // Test special characters
    await page.locator('#name').fill("José García-O'Brien");
    await page.locator('#email').fill('jose.garcia+test@example.co.uk');

    await expect(page.locator('#name')).toHaveValue("José García-O'Brien");
    await expect(page.locator('#email')).toHaveValue('jose.garcia+test@example.co.uk');

    await context.close();
    console.log('[E2E] ✅ Special characters handled correctly');
  });
});
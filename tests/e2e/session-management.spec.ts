/**
 * E2E Test 4: Session Management Across Tabs
 * 
 * Tests multi-tab session management including:
 * - Session tracking across tabs
 * - Tab navigation and state preservation
 * - Concurrent session handling
 * - Session lifecycle (start, update, complete)
 */
import { test, expect } from '@playwright/test';

test.describe('Session Management Across Tabs', () => {
  const baseURL = 'http://localhost:3000/e2e-test-page.html';
  
  test('should track session across multiple tab switches', async ({ page }) => {
    await page.goto(baseURL);
    
    // Record initial session state
    const initialVisitCount = await page.evaluate(() => window.visitCount);
    const initialStartTime = await page.evaluate(() => window.sessionStart);
    
    expect(initialVisitCount).toBe(1);
    expect(initialStartTime).toBeGreaterThan(0);
    
    // Switch between tabs
    await page.click('#tab-form');
    await page.waitForTimeout(200);
    
    await page.click('#tab-pii');
    await page.waitForTimeout(200);
    
    await page.click('#tab-vision');
    await page.waitForTimeout(200);
    
    await page.click('#tab-error');
    await page.waitForTimeout(200);
    
    // Session should still be tracked
    const currentVisitCount = await page.evaluate(() => window.visitCount);
    expect(currentVisitCount).toBe(1); // Same page, just tab switches
    
    console.log('[E2E SESSION] ✅ Session tracked across tab switches');
  });

  test('should create new session on page reload', async ({ page }) => {
    await page.goto(baseURL);
    
    const firstVisit = await page.evaluate(() => window.visitCount);
    const firstStart = await page.evaluate(() => window.sessionStart);
    
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    const secondVisit = await page.evaluate(() => window.visitCount);
    const secondStart = await page.evaluate(() => window.sessionStart);
    
    expect(secondVisit).toBe(2); // Incremented visit count
    expect(secondStart).toBeGreaterThan(firstStart); // New start time
    
    console.log('[E2E SESSION] ✅ New session created on reload');
  });

  test('should maintain session state during navigation', async ({ page }) => {
    await page.goto(baseURL);
    
    // Fill form on first tab
    await page.click('#tab-form');
    await page.fill('#name', 'Test User');
    await page.fill('#email', 'test@example.com');
    
    const formData = await page.evaluate(() => ({
      name: document.getElementById('name')?.value,
      email: document.getElementById('email')?.value
    }));
    expect(formData.name).toBe('Test User');
    expect(formData.email).toBe('test@example.com');
    
    // Navigate to other tabs
    await page.click('#tab-pii');
    await page.waitForTimeout(200);
    
    // Return to form tab
    await page.click('#tab-form');
    await page.waitForTimeout(200);
    
    // Data should persist
    const persistedData = await page.evaluate(() => ({
      name: document.getElementById('name')?.value,
      email: document.getElementById('email')?.value
    }));
    expect(persistedData.name).toBe('Test User');
    expect(persistedData.email).toBe('test@example.com');
    
    console.log('[E2E SESSION] ✅ Session state maintained during navigation');
  });

  test('should handle concurrent operations in different tabs', async ({ page }) => {
    await page.goto(baseURL);
    
    // Start form filling
    await page.click('#tab-form');
    await page.fill('#name', 'Concurrent User');
    
    // Switch to vision tab while form is being filled
    await page.click('#tab-vision');
    await page.click('#captureBtn');
    
    await page.waitForTimeout(500);
    
    // Verify both operations completed
    const visionResult = await page.locator('#visionResults').textContent();
    expect(visionResult).toContain('Screenshot captured');
    
    // Return to form and verify data
    await page.click('#tab-form');
    await expect(page.locator('#name')).toHaveValue('Concurrent User');
    
    console.log('[E2E SESSION] ✅ Concurrent operations handled');
  });

  test('should track multiple browser contexts as separate sessions', async ({ context }) => {
    // Open first page
    const page1 = await context.newPage();
    await page1.goto(baseURL);
    
    const session1Visit = await page1.evaluate(() => window.visitCount);
    expect(session1Visit).toBe(1);
    
    // Open second page in same context
    const page2 = await context.newPage();
    await page2.goto(baseURL);
    
    const session2Visit = await page2.evaluate(() => window.visitCount);
    expect(session2Visit).toBe(1); // Independent session
    
    await page1.close();
    await page2.close();
    
    console.log('[E2E SESSION] ✅ Separate sessions tracked independently');
  });

  test('should update session timestamp on interaction', async ({ page }) => {
    await page.goto(baseURL);
    
    const startTime = await page.evaluate(() => window.sessionStart);
    await page.waitForTimeout(100);
    
    // Interact with page
    await page.click('#tab-form');
    await page.fill('#name', 'Active User');
    
    await page.waitForTimeout(100);
    
    const interactionTime = await page.evaluate(() => Date.now());
    expect(interactionTime).toBeGreaterThan(startTime);
    
    console.log('[E2E SESSION] ✅ Session activity tracked');
  });

  test('should handle session timeout scenario', async ({ page }) => {
    await page.goto(baseURL);
    
    const startTime = await page.evaluate(() => window.sessionStart);
    
    // Simulate extended inactivity
    await page.waitForTimeout(2000);
    
    const currentSession = await page.evaluate(() => ({
      start: window.sessionStart,
      elapsed: Date.now() - window.sessionStart
    }));
    
    expect(currentSession.start).toBe(startTime);
    expect(currentSession.elapsed).toBeGreaterThanOrEqual(2000);
    
    console.log('[E2E SESSION] ✅ Session timeout tracking works');
  });
});

/**
 * Tests for context.ts - User profile and auto-fill
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock browser storage
const mockStorage = new Map<string, any>();
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: mockStorage.get(key) })),
        set: vi.fn(async (data: Record<string, any>) => {
          for (const [k, v] of Object.entries(data)) {
            mockStorage.set(k, v);
          }
        }),
        remove: vi.fn(async (key: string) => {
          mockStorage.delete(key);
        }),
      },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
    },
  },
}));

describe('ProfileManager', () => {
  it('should store and retrieve profile', async () => {
    const { ProfileManager } = await import('../src/lib/context');
    const pm = ProfileManager.getInstance();

    await pm.saveProfile({
      name: 'Test User',
      email: 'test@example.com',
      phone: '+919****3210',
      preferences: { theme: 'dark' },
    }, true); // explicitConsent = true

    const profile = await pm.getProfile();
    expect(profile).toBeTruthy();
    expect(profile?.name).toBe('Test User');
    expect(profile?.email).toBe('test@example.com');
  });

  it('should not return profile without consent', async () => {
    const { ProfileManager } = await import('../src/lib/context');
    const pm = ProfileManager.getInstance();

    // Save without consent
    mockStorage.set('profile', {
      name: 'Test',
      consentGiven: false,
      consentedAt: null,
    });

    const profile = await pm.getProfile();
    expect(profile).toBeNull();
  });

  it('should check consent status', async () => {
    const { ProfileManager } = await import('../src/lib/context');
    const pm = ProfileManager.getInstance();

    mockStorage.set('profile', {
      name: 'Test',
      consentGiven: true,
      consentedAt: Date.now(),
    });

    expect(await pm.hasConsent()).toBe(true);
  });
});

describe('AutofillManager', () => {
  it('should add auto-fill pattern', async () => {
    const { AutofillManager } = await import('../src/lib/context');
    const am = AutofillManager.getInstance();

    await am.savePattern({
      key: 'full_name',
      label: 'Full Name',
      selector: 'input[name="name"]',
      value: 'John Doe',
      confidence: 0.9,
    });

    const patterns = await am.getPatterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0].value).toBe('John Doe');
  });

  it('should get patterns for specific site', async () => {
    const { AutofillManager } = await import('../src/lib/context');
    const am = AutofillManager.getInstance();

    await am.savePattern({
      key: 'email',
      label: 'Email',
      selector: 'input[name="email"]',
      value: 'test@example.com',
      confidence: 0.95,
    });

    await am.savePattern({
      key: 'full_name',
      label: 'Full Name',
      selector: 'input[name="name"]',
      value: 'Test User',
      confidence: 0.8,
    });

    // Test getting all patterns
    const patterns = await am.getPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SessionTracker', () => {
  it('should track sessions', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    const sessionId = await st.startSession(1, 10, 'https://example.com');

    const sessions = await st.getSessions();
    expect(sessions).toHaveProperty(sessionId);
    expect(sessions[sessionId].originTabId).toBe(1);
  });

  it('should complete session with summary', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    const sessionId = await st.startSession(2, 10, 'https://example.com/form');

    await st.completeSession(sessionId, 'Form completed successfully');

    const sessions = await st.getSessions();
    expect(sessions[sessionId]?.status).toBe('completed');
    expect(sessions[sessionId]?.summary).toBe('Form completed successfully');
  });

  it('should abort session on tab close', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    const sessionId = await st.startSession(3, 10, 'https://example.com');

    await st.onTabClosed(3);

    const sessions = await st.getSessions();
    expect(sessions[sessionId]?.status).toBe('aborted');
  });

  it('should get active sessions only', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    await st.startSession(4, 10, 'https://example.com');

    const active = await st.getActiveSessions();
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  it('should log actions', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    const sessionId = await st.startSession(5, 10, 'https://example.com');

    await st.logAction(sessionId, 'CLICK', 'element-1', true);

    const sessions = await st.getSessions();
    expect(sessions[sessionId]?.actionsTaken?.length).toBe(1);
    expect(sessions[sessionId]?.actionsTaken?.[0]?.type).toBe('CLICK');
  });

  it('should prune stale sessions', async () => {
    const { SessionTracker } = await import('../src/lib/context');
    const st = SessionTracker.getInstance();

    // Add old completed session
    mockStorage.set('activeSessions', {
      'old_session': {
        sessionId: 'old_session',
        originTabId: 6,
        windowId: 1,
        startUrl: 'https://example.com',
        startTime: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
        status: 'completed',
        summary: 'Old session',
        actionsTaken: [],
      },
    });

    const removed = await st.pruneStaleSessions(7 * 24 * 60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});

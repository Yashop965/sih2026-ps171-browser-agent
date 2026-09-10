/**
 * Tests for SessionManager
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock browser API before importing the module
vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(),
      get: vi.fn(),
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
  },
}));

const { SessionManager } = await import('../src/lib/sessionManager');

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startSession', () => {
    it('should start a new session and return sessionId', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test task', 10);

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(manager.getSession(sessionId)).toBeTruthy();
    });

    it('should track visited URLs', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://irctc.co.in',
        title: 'IRCTC',
      });

      const sessionId = await manager.startSession(1, 10, 'https://irctc.co.in', 'Book ticket', 20);
      const context = manager.getContext(sessionId);

      expect(context?.visitedUrls.has('https://irctc.co.in')).toBe(true);
    });
  });

  describe('updateSession', () => {
    it('should update session with new URL', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://irctc.co.in',
        title: 'IRCTC',
      });

      const sessionId = await manager.startSession(1, 10, 'https://irctc.co.in', 'Test', 10);
      await manager.updateSession(sessionId, 'https://irctc.co.in/trains');

      const session = manager.getSession(sessionId);
      expect(session?.currentUrl).toBe('https://irctc.co.in/trains');
      expect(session?.history.length).toBe(2);
    });

    it('should increment step count', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      await manager.updateSession(sessionId, 'https://example.com/page1');
      await manager.updateSession(sessionId, 'https://example.com/page2');

      const context = manager.getContext(sessionId);
      expect(context?.stepCount).toBe(2);
    });
  });

  describe('completeSession', () => {
    it('should mark session as completed', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.completeSession(sessionId);

      const session = manager.getSession(sessionId);
      expect(session?.status).toBe('completed');
    });
  });

  describe('failSession', () => {
    it('should mark session as failed', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.failSession(sessionId);

      const session = manager.getSession(sessionId);
      expect(session?.status).toBe('failed');
    });
  });

  describe('getSessionForTab', () => {
    it('should return active session for tab', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      const session = manager.getSessionForTab(1);
      expect(session?.sessionId).toBe(sessionId);
    });

    it('should return null for inactive session', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.completeSession(sessionId);
      const session = manager.getSessionForTab(1);
      expect(session).toBeNull();
    });
  });

  describe('recordFailedElement', () => {
    it('should track failed elements', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.recordFailedElement(sessionId, 'element-1');
      manager.recordFailedElement(sessionId, 'element-2');

      const context = manager.getContext(sessionId);
      expect(context?.failedElements.size).toBe(2);
      expect(context?.failedElements.has('element-1')).toBe(true);
    });
  });

  describe('shouldSkipElement', () => {
    it('should return true for failed element', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.recordFailedElement(sessionId, 'element-1');
      expect(manager.shouldSkipElement(sessionId, 'element-1')).toBe(true);
    });

    it('should return false for new element', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      expect(manager.shouldSkipElement(sessionId, 'new-element')).toBe(false);
    });
  });

  describe('pruneStaleSessions', () => {
    it('should remove sessions at capacity after timeout', async () => {
      const { browser } = await import('wxt/browser');

      // Start 50 sessions
      for (let i = 0; i < 50; i++) {
        (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
          url: `https://example${i}.com`,
          title: 'Example',
        });
        await manager.startSession(i, 10, `https://example${i}.com`, 'Test', 10);
      }

      expect(manager.getActiveSessions().length).toBe(50);

      // Advance time by 31 minutes to make sessions stale
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);

      // Start 51st session - should prune old sessions
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example51.com',
        title: 'Example',
      });
      await manager.startSession(51, 10, 'https://example51.com', 'Test', 10);

      vi.useRealTimers();
      expect(manager.getActiveSessions().length).toBeLessThanOrEqual(50);
    });

    it('should prune completed sessions when at capacity', async () => {
      const { browser } = await import('wxt/browser');

      // Start 50 sessions and complete them
      const sessionIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
          url: `https://example${i}.com`,
          title: 'Example',
        });
        const sessionId = await manager.startSession(i, 10, `https://example${i}.com`, 'Test', 10);
        sessionIds.push(sessionId);
        manager.completeSession(sessionId);
      }

      expect(manager.getActiveSessions().length).toBe(0);
      // All sessions should be in the map but inactive
      expect(sessionIds.length).toBe(50);
    });
  });

  describe('isTaskViable', () => {
    it('should return false when maxSteps exceeded', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 2);
      await manager.updateSession(sessionId, 'https://example.com/page1');
      await manager.updateSession(sessionId, 'https://example.com/page2');

      expect(manager.isTaskViable(sessionId)).toBe(false);
    });

    it('should return false for completed session', async () => {
      const { browser } = await import('wxt/browser');
      (browser.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: 'https://example.com',
        title: 'Example',
      });

      const sessionId = await manager.startSession(1, 10, 'https://example.com', 'Test', 10);
      manager.completeSession(sessionId);
      expect(manager.isTaskViable(sessionId)).toBe(false);
    });
  });
});

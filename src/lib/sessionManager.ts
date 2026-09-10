/**
 * Multi-Site Session Manager
 *
 * Tracks agent sessions across multiple tabs and sites,
 * enabling complex multi-step workflows like:
 * "Book a train ticket" → IRCTC → Select train → Fill form → Payment → Confirmation
 */

import { browser } from 'wxt/browser';
import type { ExtractedElement } from './dom';
import type { BoundingBox } from './vision/florence2';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageSnapshot {
  url: string;
  title: string;
  timestamp: number;
  elementCount: number;
  elements?: ExtractedElement[];
  visionBoxes?: BoundingBox[];
  scrollY: number;
}

export interface SessionState {
  sessionId: string;
  tabId: number;
  windowId: number;
  startUrl: string;
  currentUrl: string;
  startTime: number;
  lastActivity: number;
  status: 'active' | 'paused' | 'completed' | 'failed';
  history: Array<{
    url: string;
    timestamp: number;
    action?: string;
    elements?: number;
  }>;
  snapshot: PageSnapshot | null;
}

export interface SessionContext {
  taskDescription: string;
  stepCount: number;
  maxSteps: number;
  failedElements: Set<string>;
  visitedUrls: Set<string>;
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private contextMap = new Map<string, SessionContext>();
  private readonly MAX_SESSIONS = 50;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Start a new session for a tab
   */
  async startSession(
    tabId: number,
    windowId: number,
    url: string,
    taskDescription: string,
    maxSteps: number = 50
  ): Promise<string> {
    const sessionId = this.generateSessionId();

    // Prune stale sessions if at capacity
    if (this.sessions.size >= this.MAX_SESSIONS) {
      this.pruneStaleSessions();
    }

    const snapshot = await this.capturePageSnapshot(tabId);

    const session: SessionState = {
      sessionId,
      tabId,
      windowId,
      startUrl: url,
      currentUrl: url,
      startTime: Date.now(),
      lastActivity: Date.now(),
      status: 'active',
      history: [{ url, timestamp: Date.now() }],
      snapshot,
    };

    const context: SessionContext = {
      taskDescription,
      stepCount: 0,
      maxSteps,
      failedElements: new Set(),
      visitedUrls: new Set([url]),
    };

    this.sessions.set(sessionId, session);
    this.contextMap.set(sessionId, context);

    // Listen for tab updates
    browser.tabs.onUpdated.addListener((updatedTabId) => {
      if (updatedTabId === tabId) {
        this.handleTabUpdate(sessionId, updatedTabId);
      }
    });

    console.log(`[SessionManager] Started session ${sessionId} for tab ${tabId}`);
    return sessionId;
  }

  /**
   * Get active session for a tab
   */
  getSessionForTab(tabId: number): SessionState | null {
    for (const session of this.sessions.values()) {
      if (session.tabId === tabId && session.status === 'active') {
        return session;
      }
    }
    return null;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Update session with new page state
   */
  async updateSession(
    sessionId: string,
    url: string,
    elements?: ExtractedElement[],
    visionBoxes?: BoundingBox[]
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.currentUrl = url;
    session.lastActivity = Date.now();
    session.history.push({
      url,
      timestamp: Date.now(),
    });

    // Note: snapshot stores minimal metadata only
    // Full DOM extraction happens in content script context
    session.snapshot = {
      url,
      title: '', // Title fetched from content script, not background
      timestamp: Date.now(),
      elementCount: elements?.length || 0,
      elements,
      visionBoxes,
      scrollY: 0, // Scroll position tracked in content script
    };

    // Update context
    const context = this.contextMap.get(sessionId);
    if (context) {
      context.stepCount++;
      context.visitedUrls.add(url);
    }

    console.log(`[SessionManager] Updated session ${sessionId} - step ${context?.stepCount}`);
  }

  /**
   * Mark session as completed
   */
  completeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'completed';
    session.lastActivity = Date.now();

    console.log(`[SessionManager] Completed session ${sessionId}`);
  }

  /**
   * Mark session as failed
   */
  failSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'failed';
    session.lastActivity = Date.now();

    console.warn(`[SessionManager] Failed session ${sessionId}`);
  }

  /**
   * Pause a session (e.g., when user switches away)
   */
  pauseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    session.status = 'paused';
    session.lastActivity = Date.now();
  }

  /**
   * Resume a paused session
   */
  resumeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'paused') return;

    session.status = 'active';
    session.lastActivity = Date.now();
  }

  /**
   * Record a failed element
   */
  recordFailedElement(sessionId: string, elementId: string): void {
    const context = this.contextMap.get(sessionId);
    if (!context) return;

    context.failedElements.add(elementId);
  }

  /**
   * Check if an element has failed too many times
   */
  shouldSkipElement(sessionId: string, elementId: string): boolean {
    const context = this.contextMap.get(sessionId);
    if (!context) return false;

    // Skip if this element has failed before
    return context.failedElements.has(elementId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values())
      .filter(s => s.status === 'active' || s.status === 'paused');
  }

  /**
   * Get session context
   */
  getContext(sessionId: string): SessionContext | null {
    return this.contextMap.get(sessionId) || null;
  }

  /**
   * Check if task is still viable
   */
  isTaskViable(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const context = this.contextMap.get(sessionId);

    if (!session || !context) return false;
    if (session.status !== 'active') return false;
    if (context.stepCount >= context.maxSteps) return false;

    // Check timeout
    const elapsed = Date.now() - session.startTime;
    if (elapsed > this.SESSION_TIMEOUT_MS) {
      console.warn(`[SessionManager] Session ${sessionId} timed out`);
      this.failSession(sessionId, 'Session timed out');
      return false;
    }

    return true;
  }

  /**
   * Clean up stale sessions
   */
  private pruneStaleSessions(): void {
    const now = Date.now();
    const stale: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status !== 'active' && session.status !== 'paused') {
        stale.push(id);
        continue;
      }
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        stale.push(id);
      }
    }

    for (const id of stale) {
      this.sessions.delete(id);
      this.contextMap.delete(id);
      console.log(`[SessionManager] Pruned stale session ${id}`);
    }
  }

  /**
   * Handle tab URL changes
   */
  private async handleTabUpdate(sessionId: string, tabId: number): Promise<void> {
    try {
      const tab = await browser.tabs.get(tabId);
      const session = this.sessions.get(sessionId);
      if (!session) return;

      // Update current URL
      session.currentUrl = tab.url || session.currentUrl;
      session.lastActivity = Date.now();

      // Add to history
      session.history.push({
        url: tab.url || '',
        timestamp: Date.now(),
      });

      // Update context
      const context = this.contextMap.get(sessionId);
      if (context) {
        context.visitedUrls.add(tab.url || '');
      }
    } catch (err) {
      console.warn(`[SessionManager] Failed to handle tab update:`, err);
    }
  }

  /**
   * Capture current page state
   */
  private async capturePageSnapshot(tabId: number): Promise<PageSnapshot> {
    try {
      const tab = await browser.tabs.get(tabId);
      return {
        url: tab.url || '',
        title: tab.title || '',
        timestamp: Date.now(),
        elementCount: 0,
        scrollY: 0,
      };
    } catch {
      return {
        url: '',
        title: '',
        timestamp: Date.now(),
        elementCount: 0,
        scrollY: 0,
      };
    }
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

export const sessionManager = new SessionManager();

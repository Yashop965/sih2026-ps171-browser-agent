/**
 * Lightweight Context / Memory System
 *
 * Three pillars:
 *  1. User Profile Storage  — opt-in "about me" persisted in chrome.storage,
 *                            always gated behind explicit permission.
 *  2. Auto-fill Patterns   — recognises recurring form-field patterns across
 *                            sites and offers one-click filling.
 *  3. Multi-tab Session Tracking — maps agent sessions to their originating
 *                                  tab(s) and survives tab-close / re-open.
 *
 * All data lives in chrome.storage.local only. Nothing is transmitted to the
 * server unless the user explicitly triggers an action that touches the data.
 */

// ─── Public Types ────────────────────────────────────────────────────────────

export interface UserProfile {
  /** Free-form "about me" text the user wants the agent to know. */
  aboutMe: string;
  /** Explicit consent given by the user to use this data. */
  consentGiven: boolean;
  consentedAt: number | null;
}

export interface AutoFillPattern {
  /** Stable key: e.g. "name", "email", "address_line_1". */
  key: string;
  /** Display label shown in the UI. */
  label: string;
  /** DOM selector the agent can use to target the field. */
  selector: string;
  /** Cached value the user has confirmed is correct. */
  value: string;
  /** Number of times this pattern has been successfully filled. */
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface SessionRecord {
  /** Unique ID for this agent run. */
  sessionId: string;
  /** Tab ID where the session was started. */
  originTabId: number | null;
  /** Window ID of the originating tab. */
  windowId: number | null;
  /** URL the session started on (for audit / recall). */
  startUrl: string;
  startTime: number;
  /** Current status. */
  status: 'active' | 'completed' | 'aborted';
  /** List of actions taken during the session. */
  actionsTaken: Array<{
    type: string;
    targetId?: string | number;
    timestamp: number;
    success: boolean;
  }>;
  /** Summary produced when the session ends. */
  summary?: string;
}

/** Shape stored under chrome.storage.local.'pii-agent-context' */
interface StoredContext {
  profile: UserProfile | null;
  autoFillPatterns: AutoFillPattern[];
  activeSessions: Record<string, SessionRecord>;
  lastSessionId: string | null;
}

// ─── Storage Keys ────────────────────────────────────────────────────────────
// Individual keys are passed directly to browser.storage APIs below.

// In MV3 + WXT the `browser` namespace works in content scripts and the
// service worker. The popup must use `chrome.storage` directly because it
// runs in an extension iframe (see WXT skill pitfall #5).
async function getStored<T extends keyof StoredContext>(key: T): Promise<StoredContext[T]> {
  const result = await browser.storage.local.get(key);
  return (result as Record<string, unknown>)[key] as StoredContext[T];
}

async function setStored<T extends keyof StoredContext>(
  key: T,
  value: StoredContext[T]
): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

// ─── 1. User Profile Storage ────────────────────────────────────────────────

export class ProfileManager {
  private static instance: ProfileManager | null = null;

  static getInstance(): ProfileManager {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
    }
    return ProfileManager.instance;
  }

  /**
   * Read the current profile. Returns null if none exists or consent is absent.
   */
  async getProfile(): Promise<UserProfile | null> {
    const profile = await getStored('profile');
    if (!profile || !profile.consentGiven) return null;
    return profile;
  }

  /**
   * Check whether the user has explicitly consented to profile storage.
   */
  async hasConsent(): Promise<boolean> {
    const profile = await getStored('profile');
    return profile?.consentGiven ?? false;
  }

  /**
   * Request consent from the user. This should be called from the popup UI
   * (never from the background) so the user sees a clear prompt.
   *
   * Returns true if consent was given, false otherwise.
   */
  async requestConsent(): Promise<boolean> {
    // In a real implementation this would show a native or extension UI.
    // For now we return a promise that resolves to false — the caller should
    // present its own dialog and call saveProfile() on acceptance.
    return false;
  }

  /**
   * Save a profile after the user has explicitly opted in.
   *
   * @param profile - The profile data to persist.
   * @param explicitConsent - Must be true; the caller is responsible for
   *                          having obtained user permission via a UI dialog.
   */
  async saveProfile(profile: Omit<UserProfile, 'consentedAt'>, explicitConsent: boolean): Promise<void> {
    if (!explicitConsent) {
      throw new Error('Cannot save profile without explicit user consent');
    }
    const now = Date.now();
    const stored: UserProfile = {
      ...profile,
      consentGiven: true,
      consentedAt: now,
    };
    await setStored('profile', stored);
  }

  /**
   * Update just the about-me text without re-requesting consent (consent is
   * already on record).
   */
  async updateAboutMe(aboutMe: string): Promise<void> {
    const current = await this.getProfile();
    if (!current) {
      throw new Error('No profile found; call requestConsent() first');
    }
    await this.saveProfile({ aboutMe, consentGiven: false }, true);
  }

  /**
   * Revoke consent and wipe the profile. Irreversible from storage perspective;
   * the object is removed but chrome.storage.local history may retain it until
   * cleared. Callers should treat this as the privacy guarantee boundary.
   */
  async revokeConsent(): Promise<void> {
    await browser.storage.local.remove(['profile']);
  }
}

// ─── 2. Auto-fill Patterns ──────────────────────────────────────────────────

export class AutofillManager {
  private static instance: AutofillManager | null = null;

  static getInstance(): AutofillManager {
    if (!AutofillManager.instance) {
      AutofillManager.instance = new AutofillManager();
    }
    return AutofillManager.instance;
  }

  private static readonly KNOWN_KEYS: Array<{ key: string; label: string; sampleSelector: string }> = [
    { key: 'full_name', label: 'Full Name', sampleSelector: 'input[name="name"], input[placeholder*="name"], input[name="full_name"]' },
    { key: 'first_name', label: 'First Name', sampleSelector: 'input[name="first_name"], input[placeholder*="first name"]' },
    { key: 'last_name', label: 'Last Name', sampleSelector: 'input[name="last_name"], input[placeholder*="last name"]' },
    { key: 'email', label: 'Email', sampleSelector: 'input[type="email"], input[name="email"]' },
    { key: 'phone', label: 'Phone', sampleSelector: 'input[type="tel"], input[name="phone"]' },
    { key: 'address_line_1', label: 'Address Line 1', sampleSelector: 'input[name="address"], input[placeholder*="address"]' },
    { key: 'city', label: 'City', sampleSelector: 'input[name="city"], input[placeholder*="city"]' },
    { key: 'pincode', label: 'Pincode / Zip', sampleSelector: 'input[name="pincode"], input[name="zip"], input[placeholder*="pin"]' },
    { key: 'aadhaar', label: 'Aadhaar No.', sampleSelector: 'input[name="aadhaar"], input[placeholder*="aadhaar"]' },
    { key: 'pan', label: 'PAN No.', sampleSelector: 'input[name="pan"], input[placeholder*="pan"]' },
  ];

  /** Return all known pattern definitions (used to populate the pattern picker). */
  getKnownPatterns(): Array<{ key: string; label: string; sampleSelector: string }> {
    return AutofillManager.KNOWN_KEYS;
  }

  /**
   * Load persisted auto-fill values from storage.
   * Returns an empty array when no patterns have been saved yet.
   */
  async getPatterns(): Promise<AutoFillPattern[]> {
    const patterns = await getStored('autoFillPatterns');
    return patterns ?? [];
  }

  /**
   * Save a pattern. The `value` is what the user wants pre-filled; it is stored
   * locally only and never transmitted to the planner server.
   */
  async savePattern(pattern: Omit<AutoFillPattern, 'usageCount' | 'lastUsedAt' | 'createdAt'>): Promise<void> {
    const patterns = await this.getPatterns();
    const existing = patterns.find(p => p.key === pattern.key);
    if (existing) {
      existing.value = pattern.value;
      existing.selector = pattern.selector;
    } else {
      patterns.push({
        ...pattern,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: Date.now(),
      });
    }
    await setStored('autoFillPatterns', patterns);
  }

  /**
   * Remove a pattern by key.
   */
  async removePattern(key: string): Promise<void> {
    const patterns = await this.getPatterns();
    const filtered = patterns.filter(p => p.key !== key);
    await setStored('autoFillPatterns', filtered);
  }

  /**
   * Increment usage counter and update last-used timestamp. Called after a
   * successful fill so the UI can surface the most-used patterns.
   */
  async recordUsage(key: string, selector: string): Promise<void> {
    const patterns = await this.getPatterns();
    const entry = patterns.find(p => p.key === key);
    if (entry) {
      entry.usageCount += 1;
      entry.lastUsedAt = Date.now();
      entry.selector = selector; // update to the selector actually used
    }
    await setStored('autoFillPatterns', patterns);
  }

  /**
   * Suggest patterns for a given DOM snapshot. Returns patterns whose selector
   * matches any element in the snapshot, sorted by usage count.
   */
  async suggestForSnapshot(snapshot: { url: string; elements: Array<{ id: number | string; tag: string; role: string; label: string; selector?: string }> }): Promise<AutoFillPattern[]> {
    const patterns = await this.getPatterns();
    const matched = patterns.filter(p => {
      // Heuristic: if the pattern's selector appears in any element's selector,
      // or the element's label contains the pattern keyword.
      return snapshot.elements.some(el => {
        if (el.selector && el.selector.includes(p.key)) return true;
        if (el.label.toLowerCase().includes(p.key.split('_').join(' '))) return true;
        return false;
      });
    });
    return matched.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
  }

  /**
   * Build a one-click fill action list for a snapshot.
   * Returns an array of { targetId, value } pairs ready for the executor.
   */
  async buildFillActions(
    snapshot: { url: string; elements: Array<{ id: number | string; tag: string; role: string; label: string; selector?: string }> },
    limit: number = 5
  ): Promise<Array<{ targetId: number | string; value: string; patternKey: string }>> {
    const suggestions = await this.suggestForSnapshot(snapshot);
    return suggestions.slice(0, limit).map(p => {
      const el = snapshot.elements.find(e =>
        e.selector?.includes(p.key) || e.label.toLowerCase().includes(p.key.split('_').join(' '))
      );
      return {
        targetId: el?.id ?? p.key,
        value: p.value,
        patternKey: p.key,
      };
    }).filter(a => a.targetId !== a.patternKey); // only include if we found a matching element
  }
}

// ─── 3. Multi-tab Session Tracking ───────────────────────────────────────────

export class SessionTracker {
  private static instance: SessionTracker | null = null;

  static getInstance(): SessionTracker {
    if (!SessionTracker.instance) {
      SessionTracker.instance = new SessionTracker();
    }
    return SessionTracker.instance;
  }

  /**
   * Create a new session record and persist it. Returns the sessionId.
   */
  async startSession(originTabId: number, windowId: number, startUrl: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const record: SessionRecord = {
      sessionId,
      originTabId,
      windowId,
      startUrl,
      startTime: Date.now(),
      status: 'active',
      actionsTaken: [],
    };
    const sessions = await this.getSessions();
    sessions[sessionId] = record;
    await setStored('activeSessions', sessions);
    await setStored('lastSessionId', sessionId);
    return sessionId;
  }

  /**
   * Log an action taken during the current session.
   */
  async logAction(
    sessionId: string,
    actionType: string,
    targetId?: string | number,
    success: boolean = true
  ): Promise<void> {
    const sessions = await this.getSessions();
    const record = sessions[sessionId];
    if (!record || record.status !== 'active') return;
    record.actionsTaken.push({
      type: actionType,
      targetId,
      timestamp: Date.now(),
      success,
    });
    await setStored('activeSessions', sessions);
  }

  /**
   * Mark a session as completed with an optional human-readable summary.
   */
  async completeSession(sessionId: string, summary?: string): Promise<void> {
    const sessions = await this.getSessions();
    const record = sessions[sessionId];
    if (!record || record.status !== 'active') return;
    record.status = 'completed';
    record.summary = summary;
    sessions[sessionId] = record;
    await setStored('activeSessions', sessions);
  }

  /**
   * Abort a session (e.g. user cancelled, tab closed unexpectedly).
   */
  async abortSession(sessionId: string): Promise<void> {
    const sessions = await this.getSessions();
    const record = sessions[sessionId];
    if (!record || record.status !== 'active') return;
    record.status = 'aborted';
    sessions[sessionId] = record;
    await setStored('activeSessions', sessions);
  }

  /**
   * Return all currently active (non-completed / non-aborted) sessions.
   * Useful for the popup to show "running tasks" across tabs.
   */
  async getActiveSessions(): Promise<SessionRecord[]> {
    const sessions = await this.getSessions();
    return Object.values(sessions).filter(s => s.status === 'active');
  }

  /**
   * Return the last N completed/aborted sessions (for history view).
   */
  async getRecentSessions(limit: number = 10): Promise<SessionRecord[]> {
    const sessions = await this.getSessions();
    return Object.values(sessions)
      .filter(s => s.status !== 'active')
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  /**
   * Return the full store for background-script inspection.
   */
  private async getSessions(): Promise<Record<string, SessionRecord>> {
    const raw = await getStored('activeSessions');
    return raw ?? {};
  }

  /**
   * Clean up stale sessions: remove entries older than `maxAgeMs` that are
   * already completed or aborted. This prevents unbounded growth of
   * chrome.storage.local.
   */
  async pruneStaleSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const sessions = await this.getSessions();
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of Object.entries(sessions)) {
      if (record.status !== 'active' && (now - record.startTime) > maxAgeMs) {
        delete sessions[id];
        removed++;
      }
    }
    if (removed > 0) {
      await setStored('activeSessions', sessions);
    }
    return removed;
  }

  /**
   * When a tab is closed, mark any session originating from that tab as aborted.
   * Called from the background script via `browser.tabs.onRemoved`.
   */
  async onTabClosed(tabId: number): Promise<void> {
    const sessions = await this.getSessions();
    for (const record of Object.values(sessions)) {
      if (record.originTabId === tabId && record.status === 'active') {
        record.status = 'aborted';
        record.summary = `Tab ${tabId} was closed`;
      }
    }
    await setStored('activeSessions', sessions);
  }
}

// ─── Init / Cleanup ──────────────────────────────────────────────────────────

/**
 * Call once on background startup to register the tab-closed listener and
 * run a one-time cleanup pass.
 */
export async function initContextSystem(): Promise<void> {
  // Prune stale completed sessions on every start-up.
  const removed = await SessionTracker.getInstance().pruneStaleSessions();
  if (removed > 0) {
    console.log(`[context] Pruned ${removed} stale session(s)`);
  }

  // Listen for tab closures so we can mark orphaned sessions as aborted.
  browser.tabs.onRemoved.addListener(async (tabId) => {
    await SessionTracker.getInstance().onTabClosed(tabId);
  });
}

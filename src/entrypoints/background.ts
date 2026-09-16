import { defineBackground } from 'wxt/sandbox';
import { PrivacyAuditLedger } from '../lib/pii/audit';
import { sessionManager } from '../lib/sessionManager';

/**
 * Background Service Worker
 *
 * Handles:
 * - Message routing between content scripts and server
 * - Privacy pipeline: sanitize → firewall → transmit
 * - Privacy ledger management (legacy + new audit ledger)
 * - Action execution
 * - Image capture for vision processing
 */
export default defineBackground({
  main() {
    console.log('[PII-Agent] Background service worker started');

    const privacyLedger = new PrivacyLedger();
    const auditLedger = new PrivacyAuditLedger();
    const agentState = new AgentState();

    // Listen for messages from content scripts
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[PII-Agent] Received message:', message.type);

      switch (message.type) {
        case 'VISION_EXTRACT':
          // Request vision-enhanced extraction from content script
          (async () => {
            try {
              const tabId = sender.tab?.id;
              if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return; }
              const result: any = await browser.tabs.sendMessage(tabId, { type: 'VISION_EXTRACT' });
              sendResponse(result);
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'EXTRACT':
          // Extract DOM and log PII to ledger
          (async () => {
            try {
              // Always target a real web tab, never the extension's own
              // pages (the popup can be driven as a tab via CDP). See
              // resolveWebTab.
              const tabId = await resolveWebTab(sender);
              if (!tabId) { sendResponse({ error: 'No web tab found', ok: false }); return; }
              const snapshot: any = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });
              if (!snapshot) { sendResponse({ ok: false, error: 'No snapshot' }); return; }
              // Log PII detections
              for (const pii of snapshot.detectedPII || []) {
                privacyLedger.log({
                  timestamp: Date.now(),
                  tabId,
                  url: snapshot.url || '',
                  type: pii.type || 'PII',
                  selector: pii.selector || '',
                  confidence: pii.confidence || 1,
                  verified: Boolean(pii.isVerified),
                  action: 'DETECTED',
                });
              }
              sendResponse({
                ok: true,
                elements: snapshot.interactiveElements || [],
                // Forward page geometry + scroll affordance (issue #59). The
                // popup was previously dropping this, so the planner never
                // knew the page was taller than the viewport.
                context: snapshot.context,
                // Forward where the agent IS. Without these the server's
                // /plan fell back to url="http://localhost", so a planner
                // could never issue a meaningful NAVIGATE or know which page
                // it was looking at. (Autonomy / multi-page support.)
                url: snapshot.url || '',
                title: snapshot.title || '',
              });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'EXECUTE':
          // Execute action and log to ledger
          (async () => {
            // Resolve the target web tab BEFORE the try so the catch block can
            // also reference it when logging a navigation-triggered disconnect.
            // resolveWebTab always targets a real http(s) tab - never the
            // extension's own pages.
            let tabId = await resolveWebTab(sender);
            if (!tabId) { sendResponse({ error: 'No web tab found', ok: false }); return; }
            try {
              const action = message.action;
              const result: any = await browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
              // Log execution to ledger
              privacyLedger.log({
                timestamp: Date.now(),
                tabId,
                url: '',
                type: 'EXECUTION',
                selector: action?.targetId?.toString() || '',
                confidence: 1,
                verified: result?.ok === true,
                action: result?.ok ? 'SUCCESS' : 'FAILURE',
                error: result?.error,
              });
              sendResponse(result);
            } catch (e) {
              const msg = String(e);
              // A click/submit that NAVIGATES the tab disconnects the content
              // message channel before it can reply. The action likely worked
              // (the page moved on) - do not report that as a failure, or the
              // planner will think the click failed and retry-loop. The next
              // EXTRACT will see the new page and re-plan correctly.
              const navigated =
                /disconnect|Receiving end does not exist|Could not establish connection|No recipient|closed/i.test(msg);
              if (navigated) {
                privacyLedger.log({
                  timestamp: Date.now(),
                  tabId,
                  url: '',
                  type: 'EXECUTION',
                  selector: message.action?.targetId?.toString() || '',
                  confidence: 1,
                  verified: true,
                  action: 'SUCCESS',
                });
                sendResponse({ ok: true, note: 'page navigated - will re-extract the new page' });
              } else {
                sendResponse({ ok: false, error: msg });
              }
            }
          })();
          return true;

        case 'NAVIGATE_TAB':
          // Multi-page autonomy: navigate the active tab WITHOUT going through
          // the content script. A NAVIGATE run in-page would call
          // location.assign(), which unloads the page and kills the content
          // script before it can return a response. browser.tabs.update runs
          // in the service worker (which survives the page load), then we wait
          // for the new document to finish loading so the next EXTRACT sees the
          // fresh DOM instead of the half-loaded page.
          (async () => {
            try {
              // Target a real web tab, never the extension's own pages.
              let tabId = await resolveWebTab(sender);
              if (!tabId) { sendResponse({ ok: false, error: 'No web tab found' }); return; }
              const target = message.url;
              // Only http(s) - refuse javascript: and other dangerous schemes.
              let url = target;
              try {
                const parsed = new URL(target, 'http://invalid');
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                  sendResponse({ ok: false, error: `refused protocol: ${parsed.protocol}` });
                  return;
                }
                url = parsed.href;
              } catch {
                sendResponse({ ok: false, error: 'invalid url' });
                return;
              }
              await browser.tabs.update(tabId, { url });
              // Wait for the new page to settle (bounded) so the agent does not
              // re-extract a half-rendered DOM. Falls through on timeout.
              await waitForTabLoad(tabId, 10_000);
              privacyLedger.log({
                timestamp: Date.now(),
                tabId,
                url,
                type: 'EXECUTION',
                selector: 'NAVIGATE',
                confidence: 1,
                verified: true,
                action: 'SUCCESS',
              });
              sendResponse({ ok: true, url });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'GET_PRIVACY_LEDGER':
          sendResponse(privacyLedger.getEntries());
          return true;

        case 'GET_AUDIT_LOG':
          sendResponse(auditLedger.getEntries());
          return true;

        case 'CLEAR_LEDGER':
          privacyLedger.clear();
          auditLedger.clear();
          sendResponse({ success: true });
          return true;

        case 'CAPTURE_SCREENSHOT':
          return captureScreenshot(message, sender);

        case 'START_SESSION':
          return handleStartSession(message, sender);

        case 'UPDATE_SESSION':
          return handleUpdateSession(message, sender);

        case 'COMPLETE_SESSION':
          return handleCompleteSession(message, sender);

        case 'GET_SESSION':
          return handleGetSession(message, sender);

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
          return true;
      }
    });

    // Track tab lifecycle
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (changeInfo.url) {
        const session = sessionManager.getSessionForTab(tabId);
        if (session) {
          await sessionManager.updateSession(session.sessionId, changeInfo.url);
        }
      }
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      // Find and mark session as completed
      for (const session of sessionManager.getActiveSessions()) {
        if (session.tabId === tabId) {
          sessionManager.completeSession(session.sessionId, 'Tab closed');
          break;
        }
      }
    });

    // Handle actions returned from server
    browser.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
      if (message.type === 'ACTION_RESULT') {
        agentState.lastActionResult = message.result;
      }
    });
  },
});

async function captureScreenshot(
  message: ScreenshotMessage,
  sender: browser.runtime.MessageSender
): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(sender.tab?.windowId);
    return { dataUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve the tab the agent should act on: a real web page, never the
 * extension's own pages (popup, devtools, chrome://, chrome-extension://).
 *
 * Why: the popup UI is usually a sender without a tab, so we fall back to the
 * active web tab. But if the popup itself is open AS A TAB (e.g. driven via
 * CDP), that active tab IS the extension page - acting on it would make the
 * agent extract/click its own UI instead of the page the user is looking at.
 * We therefore only accept a sender tab that is a real web URL; otherwise we
 * scan the sender's window (or the current window) for an active web tab.
 */
async function resolveWebTab(sender: browser.runtime.MessageSender): Promise<number | undefined> {
  const isWeb = (u?: string) => !!u && (u.startsWith('http://') || u.startsWith('https://'));

  // 1) Sender tab, if it is a real web page (typical content-script sender).
  if (sender.tab?.id && isWeb(sender.tab?.url)) {
    return sender.tab.id;
  }

  // 2) Active web tab in the sender's window.
  const inWindow = sender.tab?.windowId
    ? { windowId: sender.tab.windowId }
    : { currentWindow: true };
  const [active] = await browser.tabs.query({ active: true, ...inWindow });
  if (active?.id && isWeb(active.url)) {
    return active.id;
  }

  // 3) Any web tab in that window (e.g. a background tab the user is on).
  const tabs = await browser.tabs.query({ ...inWindow });
  const web = tabs.find((t) => isWeb(t.url));
  return web?.id;
}

/**
 * Resolve when a tab finishes loading a (new) document, or after a timeout.
 *
 * This is what a NAVIGATE waits on before the agent re-extracts: without it,
 * the next EXTRACT would read a half-rendered DOM and the planner would act on
 * nothing. We watch tabs.onUpdated for status === 'complete' and race it
 * against a hard deadline so a stuck page (or a same-document hash change that
 * never fires a fresh load) can't wedge the whole run.
 *
 * Returns true when we observed a load-complete, false when we timed out.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // 1) Fast path: the tab is already fully loaded (e.g. navigating to the
  //    same URL, or the new page finished before we started listening).
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return true;
  } catch {
    // Tab may have been closed mid-navigation; fall through to the timeout.
  }

  return new Promise<boolean>((resolve) => {
    const listener = (_id: number, changeInfo: { status?: string; url?: string }) => {
      if (_id !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, Math.max(0, deadline - Date.now()));

    function cleanup() {
      clearTimeout(timer);
      try {
        browser.tabs.onUpdated.removeListener(listener);
      } catch {
        /* already removed / SW shutting down - safe to ignore */
      }
    }

    browser.tabs.onUpdated.addListener(listener);
  });
}

// Types
interface ScreenshotMessage {
  type: 'CAPTURE_SCREENSHOT';
}

interface PrivacyLogEntry {
  timestamp: number;
  tabId: number;
  url: string;
  type: string;
  selector: string;
  confidence: number;
  verified: boolean;
  action: string;
  payloadSize?: number;
  actionType?: string;
  error?: string;
}

class PrivacyLedger {
  private entries: PrivacyLogEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  
  log(entry: Omit<PrivacyLogEntry, 'timestamp'> & Partial<PrivacyLogEntry>): void {
    this.entries.unshift({
      timestamp: Date.now(),
      ...entry,
    });
    
    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(0, this.MAX_ENTRIES);
    }
  }
  
  getEntries(): PrivacyLogEntry[] {
    return this.entries;
  }
  
  clear(): void {
    this.entries = [];
  }
  
  getSummary(): { total: number; byType: Record<string, number>; byAction: Record<string, number> } {
    const byType: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    
    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    }
    
    return {
      total: this.entries.length,
      byType,
      byAction,
    };
  }
}

class AgentState {
  currentTask: string | null = null;
  lastActionResult: any = null;
  stepCount: number = 0;
}

// ─── Session Handlers ────────────────────────────────────────────────────────

async function handleStartSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const windowId = sender.tab?.windowId || activeTab?.windowId;

  const sessionId = await sessionManager.startSession(
    tabId,
    windowId || 0,
    message.url || activeTab?.url || '',
    message.taskDescription || '',
    message.maxSteps || 50
  );

  return { success: true, sessionId };
}

async function handleUpdateSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  await sessionManager.updateSession(session.sessionId, message.url || session.currentUrl);

  return { success: true };
}

async function handleCompleteSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  sessionManager.completeSession(session.sessionId, message.summary);

  return { success: true };
}

async function handleGetSession(
  message: any,
  sender: browser.runtime.MessageSender
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  const session = sessionManager.getSessionForTab(tabId);
  if (!session) return { error: 'No active session for this tab' };

  return { success: true, session };
}

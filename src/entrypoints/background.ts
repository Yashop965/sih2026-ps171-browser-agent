import { defineBackground } from 'wxt/sandbox';
import { PrivacyAuditLedger } from '../lib/pii/audit';
import { sessionManager } from '../lib/sessionManager';
import { PrivacyLedger, type PrivacyLogEntry } from '../lib/pii/privacyLedger';
import { AgentRunner, emptyTaskState, type AgentTaskState } from '../lib/agentRunner';

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

    // Issue #72: the ledgers were in-SW singletons, recreated empty on every
    // idle-termination / reload - so a judge who reloaded the extension saw a
    // blank "tamper-proof" audit trail. Persist to browser.storage.local:
    // hydrate the last snapshot at SW start, then write-through on every
    // change (fire-and-forget; storage.local survives SW death and holds the
    // SHA-256 export inputs across sessions).
    const PRIVACY_LEDGER_KEY = 'sih_privacy_ledger';
    const AUDIT_LEDGER_KEY = 'sih_audit_ledger';

    const persistPrivacyLedger = async (entries: PrivacyLogEntry[]) => {
      try {
        await browser.storage.local.set({ [PRIVACY_LEDGER_KEY]: entries });
      } catch {
        // Swallowed: durability is best-effort, never block the live loop.
      }
    };
    const persistAuditLedger = async (entries: any[]) => {
      try {
        await browser.storage.local.set({ [AUDIT_LEDGER_KEY]: entries });
      } catch {
        // best-effort, as above
      }
    };

    const privacyLedger = new PrivacyLedger([], persistPrivacyLedger);
    const auditLedger = new PrivacyAuditLedger([], persistAuditLedger);
    const agentState = new AgentState();

    // ─── Issue #71: SW-owned task runner ─────────────────────────────────────
    // The agent loop now lives here, not in the popup. The popup is a thin
    // view that subscribes to TASK_PROGRESS broadcasts. Closing the popup no
    // longer aborts a run; the state survives until the SW itself restarts.
    let activeTask: AgentTaskState = emptyTaskState();
    let stopFlag = { stopped: false };
    let abortController = new AbortController();

    // Persist the live task state so a SW restart can still surface "what
    // happened" (best-effort; the run itself dies with the SW by design).
    const TASK_STATE_KEY = 'sih_agent_task_state';
    const persistTaskState = async (state: AgentTaskState) => {
      activeTask = state;
      try {
        await browser.storage.local.set({ [TASK_STATE_KEY]: state });
      } catch {
        /* best-effort */
      }
    };
    const broadcastProgress = (state: AgentTaskState) => {
      persistTaskState(state);
      try {
        browser.runtime.sendMessage({ type: 'TASK_PROGRESS', state }).catch(() => {});
      } catch {
        /* no listeners - fine */
      }
    };

    // Rehydrate the last task snapshot so the popup shows the previous run's
    // result instead of a blank "idle".
    (async () => {
      try {
        const snap = await browser.storage.local.get(TASK_STATE_KEY);
        if (snap[TASK_STATE_KEY]) activeTask = snap[TASK_STATE_KEY];
      } catch {
        /* first launch */
      }
    })();

    // Narrow channels the runner uses - each delegates to the existing
    // content/background plumbing.
    const extractChannel = async (): Promise<any> => {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = activeTab?.id;
      if (tabId === undefined) return { ok: false, error: 'No active tab' };
      try {
        const snapshot: any = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });
        if (!snapshot) return { ok: false, error: 'No snapshot' };
        for (const pii of snapshot.detectedPII || []) {
          privacyLedger.log({
            timestamp: Date.now(), tabId, url: snapshot.url || '', type: pii.type || 'PII',
            selector: pii.selector || '', confidence: pii.confidence || 1,
            verified: Boolean(pii.isVerified), action: 'DETECTED',
          });
        }
        return {
          ok: true,
          elements: snapshot.interactiveElements || [],
          context: snapshot.context,
          url: snapshot.url || '',
          title: snapshot.title || '',
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };

    const executeChannel = async (action: any): Promise<any> => {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = activeTab?.id;
      if (tabId === undefined) return { ok: false, error: 'No web tab found' };
      try {
        const result: any = await browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
        privacyLedger.log({
          timestamp: Date.now(), tabId, url: '', type: 'EXECUTION',
          selector: action?.targetId?.toString() || '', confidence: 1,
          verified: result?.ok === true,
          action: result?.ok ? 'SUCCESS' : 'FAILURE',
          error: result?.error,
        });
        return result;
      } catch (e) {
        const msg = String(e);
        // A click/submit that NAVIGATES the tab disconnects the content port
        // before it can reply (#86). The action likely worked - the next
        // EXTRACT re-plans on the new page. Do NOT report it as a failure.
        const navigated =
          /disconnect|Receiving end does not exist|Could not establish connection|No recipient|closed/i.test(msg);
        if (navigated) {
          privacyLedger.log({
            timestamp: Date.now(), tabId, url: '', type: 'EXECUTION',
            selector: action?.targetId?.toString() || '', confidence: 1,
            verified: true, action: 'SUCCESS',
          });
          return { ok: true, note: 'page navigated - will re-extract the new page' };
        }
        return { ok: false, error: msg };
      }
    };

    const navigateChannel = async (url: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        let target = url;
        try {
          const parsed = new URL(url, 'http://invalid');
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false, error: `refused protocol: ${parsed.protocol}` };
          }
          target = parsed.href;
        } catch {
          return { ok: false, error: 'invalid url' };
        }
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id === undefined) return { ok: false, error: 'No web tab found' };
        await browser.tabs.update(activeTab.id, { url: target });
        await waitForTabLoad(activeTab.id, 10_000);
        privacyLedger.log({
          timestamp: Date.now(), tabId: activeTab.id, url: target, type: 'EXECUTION',
          selector: 'NAVIGATE', confidence: 1, verified: true, action: 'SUCCESS',
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };

    const fetchPlan = async (payload: unknown, signal?: AbortSignal): Promise<any> => {
      const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:8000';
      try {
        const response = await fetch(`${serverUrl}/plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        if (!response.ok) return null; // runner logs the non-OK path as an abort/offline
        return await response.json();
      } catch {
        // AbortError (Stop pressed mid-request) or a network failure. Either
        // way there is no plan to act on this step; the loop stops/re-checks.
        return null;
      }
    };

    // Start (or restart) the SW-owned runner for a task.
    const startTask = async (message: any, sender: browser.runtime.MessageSender) => {
      // A popup-originated message has no sender.tab, so resolve the active
      // web tab to target. The runner's channels re-resolve the active tab per
      // call, so it always acts on the page the user is looking at.
      let windowId = sender.tab?.windowId ?? 0;
      try {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id !== undefined) {
          windowId = activeTab.windowId ?? windowId;
        }
      } catch {
        /* keep the sender-derived window */
      }

      // Stop any previous run before starting a new one.
      stopFlag = { stopped: false };
      abortController = new AbortController();

      const runner = new AgentRunner({
        extract: extractChannel,
        execute: executeChannel,
        navigate: navigateChannel,
        fetchPlan,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        sessionManager,
        tabId: -1, // bookkeeping id; the channels resolve the live tab
        windowId,
        task: message.task || '',
        startUrl: message.startUrl,
        onProgress: broadcastProgress,
        isStopped: () => stopFlag.stopped,
        abortSignal: abortController.signal,
      });
      runner.run().catch((e) => {
        console.error('[agent-runner] unhandled loop error:', e);
        broadcastProgress({
          ...emptyTaskState(),
          status: 'failed',
          logs: [`${new Date().toLocaleTimeString()}: Run error: ${e instanceof Error ? e.message : String(e)}`],
          lastUpdate: Date.now(),
        });
      });
    };

    // Hydrate after construction (non-blocking: the SW keeps running even if
    // storage hasn't loaded yet - the live loop never waits on the audit
    // trail). Runs after the ledgers exist so it can call hydrate() on them.
    (async () => {
      let privacyInitial: PrivacyLogEntry[] = [];
      let auditInitial: any[] = [];
      try {
        const snap = await browser.storage.local.get([PRIVACY_LEDGER_KEY, AUDIT_LEDGER_KEY]);
        privacyInitial = (snap[PRIVACY_LEDGER_KEY] as PrivacyLogEntry[]) || [];
        auditInitial = (snap[AUDIT_LEDGER_KEY] as any[]) || [];
      } catch {
        // first launch / storage unavailable - start empty.
      }
      privacyLedger.hydrate(privacyInitial);
      auditLedger.hydrate(auditInitial);
    })();

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

        case 'START_TASK':
          // Issue #71/#69: spawn the SW-owned runner. Fire-and-forget; the
          // runner reports progress via TASK_PROGRESS broadcasts.
          startTask(message, sender);
          sendResponse({ ok: true, running: true });
          return true;

        case 'STOP_TASK':
          stopFlag.stopped = true;
          abortController.abort();
          sendResponse({ ok: true });
          return true;

        case 'GET_TASK_STATE':
          sendResponse(activeTask);
          return true;

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

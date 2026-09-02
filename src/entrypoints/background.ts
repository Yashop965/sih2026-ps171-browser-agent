import { defineBackground } from 'wxt/sandbox';
import { sanitizeSnapshot, redactString, type RawSnapshot } from '../lib/pii/sanitizer';
import { checkOutboundPayload } from '../lib/pii/firewall';
import { PrivacyAuditLedger } from '../lib/pii/audit';

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
        case 'CAPTURE_AND_SEND':
          return handleCaptureAndSend(message, sender, privacyLedger, auditLedger, agentState);

        case 'EXECUTE_ACTION':
          return executeAction(message, sender, privacyLedger);

        case 'EXTRACT':
          // Extract DOM and log PII to ledger
          (async () => {
            try {
              // Popup doesn't have sender.tab, so query for active tab
              let tabId = sender.tab?.id;
              if (!tabId) {
                const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
                tabId = activeTab?.id;
              }
              if (!tabId) { sendResponse({ error: 'No active tab', ok: false }); return; }
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
              sendResponse({ ok: true, elements: snapshot.interactiveElements || [] });
            } catch (e) {
              sendResponse({ ok: false, error: String(e) });
            }
          })();
          return true;

        case 'EXECUTE':
          // Execute action and log to ledger
          (async () => {
            try {
              let tabId = sender.tab?.id;
              if (!tabId) {
                const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
                tabId = activeTab?.id;
              }
              if (!tabId) { sendResponse({ error: 'No active tab', ok: false }); return; }
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

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
          return true;
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


async function handleCaptureAndSend(
  message: CaptureMessage,
  sender: browser.runtime.MessageSender,
  ledger: PrivacyLedger,
  auditLedger: PrivacyAuditLedger,
  state: AgentState
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  // 1. Capture raw DOM snapshot from content script
  const snapshot: RawSnapshot | null = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });

  if (!snapshot) {
    return { error: 'Failed to capture page' };
  }

  // 2. Run sanitizer — replaces PII in labels, names, title, URL, a11y tree
  const sanitized = sanitizeSnapshot(snapshot);

  // 3. Record PII detections in both ledgers
  for (const match of sanitized.matches) {
    // Legacy ledger (UI reads this)
    ledger.log({
      timestamp: Date.now(),
      tabId,
      url: snapshot.url,
      type: match.type,
      selector: match.selector,
      confidence: match.confidence,
      verified: match.isVerified,
      action: 'REDACTED',
    });
    // New audit ledger
    if (match.redacted) {
      auditLedger.redacted(match.type, match.selector, match.confidence);
    } else {
      auditLedger.detected(match.type, match.selector, match.confidence, match.isVerified);
    }
  }

  // Also log content-script-detected PII (from the detectedPII array)
  for (const pii of snapshot.detectedPII || []) {
    ledger.log({
      timestamp: Date.now(),
      tabId,
      url: snapshot.url,
      type: pii.type,
      selector: pii.selector,
      confidence: pii.confidence,
      verified: pii.isVerified ?? false,
      action: 'REDACTED',
    });
  }

  // 4. Sanitize task_description and history
  let safeTaskDescription = (message as any).task_description ?? null;
  if (typeof safeTaskDescription === 'string') {
    const { sanitized, matches } = redactString(safeTaskDescription, 'task_description');
    safeTaskDescription = sanitized;
    for (const match of matches) {
      if (match.redacted) auditLedger.redacted(match.type, match.selector, match.confidence);
      else auditLedger.detected(match.type, match.selector, match.confidence, match.isVerified);
    }
  }

  let safeHistory = (message as any).history ?? null;
  if (Array.isArray(safeHistory)) {
    safeHistory = safeHistory.map((item, i) => {
      if (!item || typeof item !== 'object') return item;
      const safeItem = { ...item };
      for (const [key, value] of Object.entries(safeItem)) {
        if (typeof value === 'string') {
          const { sanitized, matches } = redactString(value, `history[${i}].${key}`);
          safeItem[key] = sanitized;
          for (const match of matches) {
            if (match.redacted) auditLedger.redacted(match.type, match.selector, match.confidence);
            else auditLedger.detected(match.type, match.selector, match.confidence, match.isVerified);
          }
        }
      }
      return safeItem;
    });
  }

  // 5. Build the final server payload matching PlanRequest
  const serverPayload = {
    payload: sanitized.payload,
    task_description: safeTaskDescription,
    history: safeHistory,
  };

  // 6. Outbound firewall — final check before network transmission on ENTIRE payload
  const firewallResult = checkOutboundPayload(serverPayload);
  if (!firewallResult.passed) {
    auditLedger.blocked(
      firewallResult.blockedCategory ?? 'UNKNOWN',
      firewallResult.location ?? 'unknown',
      firewallResult.reason ?? 'PII detected in outbound payload',
    );
    console.error('[PII-Agent] BLOCKED: outbound firewall caught residual PII at',
      firewallResult.location, '— category:', firewallResult.blockedCategory);
    return {
      success: false,
      error: 'Privacy firewall blocked the request — residual PII detected',
    };
  }

  // Log outbound (legacy ledger)
  ledger.log({
    timestamp: Date.now(),
    tabId,
    url: snapshot.url,
    type: 'PAYLOAD',
    selector: '',
    confidence: 1,
    verified: true,
    action: 'SENT_TO_SERVER',
    payloadSize: JSON.stringify(serverPayload).length,
  });

  // 7. Send to server
  const serverResponse = await fetchServerAction(serverPayload);

  if (serverResponse.success) {
    // Audit: SENT
    auditLedger.sent(
      sanitized.payload.interactiveElements.length,
      sanitized.payload.detectedPII.length,
    );
    ledger.log({
      timestamp: Date.now(),
      tabId,
      url: snapshot.url,
      type: 'ACTION',
      selector: '',
      confidence: 1,
      verified: true,
      action: 'SERVER_RESPONSE',
      actionType: serverResponse.action?.type,
    });
  }
  
  return serverResponse;
}

async function executeAction(
  message: ActionMessage,
  sender: browser.runtime.MessageSender,
  ledger: PrivacyLedger
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };
  
  const action = message.action;
  let success = false;
  let error: string | undefined;
  
  try {
    switch (action.type) {
      case 'CLICK':
        success = await clickElement(tabId, action.targetId);
        break;
      case 'TYPE':
        success = await typeInElement(tabId, action.targetId, action.text);
        break;
      case 'SCROLL':
        success = await scrollPage(tabId, action.direction, action.amount);
        break;
      case 'NAVIGATE':
        success = await navigateTo(tabId, action.url);
        break;
      case 'WAIT':
        success = await waitForCondition(tabId, action.condition);
        break;
      default:
        error = `Unknown action type: ${action.type}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  
  ledger.log({
    timestamp: Date.now(),
    tabId,
    url: message.url,
    type: 'EXECUTION',
    selector: action.targetId?.toString() || '',
    confidence: 1,
    verified: success,
    action: success ? 'SUCCESS' : 'FAILURE',
    error,
  });
  
  return { success, error };
}

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

async function fetchServerAction(payload: any): Promise<ServerResponse> {
  const serverUrl = __SERVER_URL__;
  
  try {
    const response = await fetch(`${serverUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    
    return await response.json();
  } catch (e) {
    console.error('[PII-Agent] Server request failed:', e);
    return {
      success: false,
      action: null,
      error: e instanceof Error ? e.message : 'Server unavailable',
    };
  }
}

async function clickElement(tabId: number, elementId: number): Promise<boolean> {
  await browser.tabs.executeScript(tabId, {
    code: `
      const el = document.querySelector('[data-agent-id="${elementId}"]');
      if (el) {
        el.click();
        true;
      } else {
        false;
      }
    `,
  });
  return true;
}

async function typeInElement(
  tabId: number,
  elementId: number,
  text: string
): Promise<boolean> {
  await browser.tabs.executeScript(tabId, {
    code: `
      const el = document.querySelector('[data-agent-id="${elementId}"]');
      if (el) {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = '${text.replace(/'/g, "\\'")}';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        true;
      } else {
        false;
      }
    `,
  });
  return true;
}

async function scrollPage(
  tabId: number,
  direction: 'up' | 'down',
  amount: number
): Promise<boolean> {
  await browser.tabs.executeScript(tabId, {
    code: `
      window.scrollBy(0, ${direction === 'down' ? amount : -amount});
      true;
    `,
  });
  return true;
}

async function navigateTo(tabId: number, url: string): Promise<boolean> {
  await browser.tabs.update(tabId, { url });
  return true;
}

async function waitForCondition(tabId: number, condition: string): Promise<boolean> {
  await browser.tabs.executeScript(tabId, {
    code: `
      await new Promise(resolve => setTimeout(resolve, 1000));
      true;
    `,
  });
  return true;
}

// Types
interface CaptureMessage {
  type: 'CAPTURE_AND_SEND';
}

interface ActionMessage {
  type: 'EXECUTE_ACTION';
  action: AgentAction;
  url: string;
}

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

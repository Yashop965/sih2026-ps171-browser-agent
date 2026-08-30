import { defineBackground } from 'wxt/sandbox';

/**
 * Background Service Worker
 *
 * Handles:
 * - Message routing between content scripts and server
 * - Privacy ledger management
 * - Action execution
 * - Image capture for vision processing
 */
defineBackground({
  main() {
    console.log('[PII-Agent] Background service worker started');

    const privacyLedger = new PrivacyLedger();
    const agentState = new AgentState();

    // Listen for messages from content scripts
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[PII-Agent] Received message:', message.type);

      switch (message.type) {
        case 'CAPTURE_AND_SEND':
          return handleCaptureAndSend(message, sender, privacyLedger, agentState);

        case 'EXECUTE_ACTION':
          return executeAction(message, sender, privacyLedger);

        case 'GET_PRIVACY_LEDGER':
          sendResponse(privacyLedger.getEntries());
          return true;

        case 'CLEAR_LEDGER':
          privacyLedger.clear();
          sendResponse({ success: true });
          return true;

        case 'CAPTURE_SCREENSHOT':
          return captureScreenshot(message, sender);

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
          return true;
      }
    });
  },
});

async function handleCaptureAndSend(
  message: CaptureMessage,
  sender: browser.runtime.MessageSender,
  ledger: PrivacyLedger,
  state: AgentState
): Promise<any> {
  const tabId = sender.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  // Get sanitized DOM from content script
  const snapshot = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });

  if (!snapshot) {
    return { error: 'Failed to capture page' };
  }

  // Log PII detections to privacy ledger
  for (const pii of snapshot.detectedPII || []) {
    ledger.log({
      timestamp: Date.now(),
      tabId,
      url: snapshot.url,
      type: pii.type,
      selector: pii.selector,
      confidence: pii.confidence,
      verified: pii.isVerified,
      action: 'REDACTED',
    });
  }

  // Prepare payload for server (sanitized metadata only)
  const payload = {
    url: snapshot.url,
    title: snapshot.title,
    timestamp: snapshot.timestamp,
    interactiveElements: snapshot.interactiveElements,
    accessibilityTree: snapshot.accessibilityTree,
    detectedPII: snapshot.detectedPII.map(pii => ({
      type: pii.type,
      selector: pii.selector,
      confidence: pii.confidence,
      verified: pii.isVerified,
    })),
    // Intentionally exclude raw HTML and sensitive values
    hasScreenshots: false,
  };

  // Log outbound payload
  ledger.log({
    timestamp: Date.now(),
    tabId,
    url: snapshot.url,
    type: 'PAYLOAD',
    selector: '',
    confidence: 1,
    verified: true,
    action: 'SENT_TO_SERVER',
    payloadSize: JSON.stringify(payload).length,
  });

  // Send to server for action planning
  const serverResponse = await fetchServerAction(payload);

  if (serverResponse.success) {
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

async function fetchServerAction(payload: SanitizedPayload): Promise<ServerResponse> {
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

interface AgentAction {
  type: 'CLICK' | 'TYPE' | 'SCROLL' | 'NAVIGATE' | 'WAIT';
  targetId?: number;
  text?: string;
  direction?: 'up' | 'down';
  amount?: number;
  url?: string;
  condition?: string;
}

interface SanitizedPayload {
  url: string;
  title: string;
  timestamp: number;
  interactiveElements: InteractiveElement[];
  accessibilityTree: ARIAElement[];
  detectedPII: DetectedPII[];
  hasScreenshots: boolean;
}

interface ServerResponse {
  success: boolean;
  action: AgentAction | null;
  error?: string;
}

interface ARIAElement {
  role: string;
  name: string;
  expanded?: boolean;
  checked?: string;
  required?: boolean;
  disabled: boolean;
  depth: number;
}

interface InteractiveElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  isPassword: boolean;
}

interface DetectedPII {
  type: string;
  value?: string;
  selector: string;
  confidence: number;
  redacted: boolean;
  isVerified?: boolean;
}
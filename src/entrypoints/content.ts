import { defineContentScript } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import {
  extract,
  getPageContext,
  sanitizedPageUrl,
  maskLabel,
  registerGroundedElement,
  getElementById,
} from '../lib/dom';
import { executeWithRetry, executeWithResilience, circuitBreaker } from '../lib/actions';
import { visionPipeline } from '../lib/vision/florence2';
import { bridgeGroundBoxes, type GroundBox } from '../lib/visionGround';
import { startThinkingPulse, stopThinkingPulse } from '../lib/agentCursor';
import { validateAadhaar, validatePAN } from '../lib/pii/validators';

/**
 * Content Script - DOM Capture + PII Redaction + Action Execution
 *
 * This script runs in the page context and:
 * 1. Captures DOM structure and accessibility tree
 * 2. Detects and redacts PII before sending to the server
 * 3. Executes actions (click, type, scroll) on elements
 * 4. Posts sanitized data to the background script
 */

// Messages the background worker can send us.
type AgentRequest =
  | { type: 'EXTRACT' }
  | { type: 'EXECUTE'; action: import('../lib/actions').Action }
  | { type: 'PING' }
  | { type: 'capturePage' }
  | { type: 'HIGHLIGHT'; selector: string }
  | { type: 'VISION_EXTRACT' } // New: DOM + Vision extraction
  | { type: 'VISION_OCR' } // #100: on-device OCR confirm
  | { type: 'CURSOR_THINKING'; on: boolean } // #132: agent-cursor breathing while the planner LLM is thinking
  | { type: 'VISION_STATUS' } // #136: on-device VLM live-indicator status
  | { type: 'HARVEST_FIELDS' } // #141: label/value pairs from this tab for cross-tab handoff
  | { type: 'VISION_GROUND'; boxes: GroundBox[]; query?: string }; // #115: bridge Florence-2 boxes -> DOM nodes

function isAgentRequest(msg: unknown): msg is AgentRequest {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return false;
  const t = (msg as { type: unknown }).type;
  return (
    t === 'EXTRACT' ||
    t === 'EXECUTE' ||
    t === 'PING' ||
    t === 'capturePage' ||
    t === 'HIGHLIGHT' ||
    t === 'VISION_EXTRACT' ||
    t === 'VISION_OCR' ||
    t === 'CURSOR_THINKING' ||
    t === 'VISION_STATUS' ||
    t === 'HARVEST_FIELDS' ||
    t === 'VISION_GROUND'
  );
}

const HIGHLIGHT_ID = '__agent-highlight';
const HIGHLIGHT_MS = 2500;

export default defineContentScript({
  matches: ['<all_urls>'],
  main(ctx) {
    console.log('[agent] content script loaded on', location.href);

    // Initialize PII detector
    const piiDetector = new PIIDetector();

    // Capture DOM snapshot with PII redaction
    function captureDOM(): SanitizedDOMSnapshot {
      const a11yTree = buildAccessibilityTree(document.documentElement);
      const interactiveElements = captureInteractiveElements();

      // Sanitize URL to remove query params that may contain PII.
      // #170: delegated to the one implementation in dom.ts. This call site
      // used to build its own URL with `search = ''` while getPageContext()
      // - one field away on the same payload - sent location.href raw, so the
      // strip was silently undone. One implementation, both call sites.
      const url = sanitizedPageUrl();

      return {
        url,
        title: document.title,
        timestamp: Date.now(),
        // SECURITY: Never send raw HTML — it contains user input (passwords, Aadhaar, PAN)
        // Instead send sanitized interactive elements only
        accessibilityTree: a11yTree,
        interactiveElements,
        detectedPII: piiDetector.scanDocument(),
        // Page geometry + scroll affordance (issue #59): lets the planner
        // know the form continues below the fold so it can scroll.
        context: getPageContext(),
      };
    }

    /**
     * Extract DOM elements + run vision inference if DOM has few elements.
     * Falls back to DOM-only when vision is unavailable.
     */
    async function extractWithVision(): Promise<{
      ok: boolean;
      elements: any[];
      context: any;
      vision?: {
        used: boolean;
        boxes?: Array<{ x: number; y: number; width: number; height: number; label: string }>;
        error?: string;
      };
    }> {
      const domElements = extract();
      const context = getPageContext();

      // If DOM found enough elements, no need for vision
      if (domElements.length >= 3) {
        return { ok: true, elements: domElements, context, vision: { used: false } };
      }

      // Request screenshot from background script
      try {
        const screenshotResult: any = await browser.runtime.sendMessage({
          type: 'CAPTURE_SCREENSHOT',
        });
        if (!screenshotResult?.dataUrl) {
          console.warn('[vision] Failed to capture screenshot, using DOM-only');
          return { ok: true, elements: domElements, context, vision: { used: false } };
        }

        // Initialize vision pipeline if not already done
        if (!visionPipeline.isInitialized()) {
          try {
            await visionPipeline.initialize();
          } catch (initErr) {
            console.warn('[vision] Failed to initialize vision pipeline:', initErr);
            return { ok: true, elements: domElements, context, vision: { used: false } };
          }
        }

        // Run OCR to detect text elements
        const visionResult = await visionPipeline.processImage(screenshotResult.dataUrl, {
          task: 'ocr',
        });

        // Merge vision boxes with DOM elements
        const mergedElements = mergeVisionWithDOM(domElements, visionResult);

        return {
          ok: true,
          elements: mergedElements,
          context,
          vision: {
            used: true,
            boxes: visionResult.boundingBoxes?.map((b) => ({
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
              label: b.label || '',
            })),
          },
        };
      } catch (visionErr) {
        console.warn('[vision] Vision extraction failed, using DOM-only:', visionErr);
        return { ok: true, elements: domElements, context, vision: { used: false } };
      }
    }

    /**
     * Issue #100 confirm path: OCR the visible screen and return ONLY the
     * text. The raw screenshot stays on-device (captured by the SW via
     * captureVisibleTab, processed here in the content script's Florence-2
     * pipeline). We never ship pixels or a PII-laden DOM back to the SW -
     * just the OCR string, which the SW matches against the open goals.
     *
     * ok:false (rather than throwing) lets the caller degrade cleanly to
     * the deterministic backstop when the model is unavailable.
     */
    async function ocrVisibleScreen(): Promise<{
      ok: boolean;
      text?: string;
      error?: string;
    }> {
      try {
        const screenshotResult: any = await browser.runtime.sendMessage({
          type: 'CAPTURE_SCREENSHOT',
        });
        if (!screenshotResult?.dataUrl) {
          visionPipeline.recordOcr(false, 'no screenshot');
          return { ok: false, error: 'no screenshot' };
        }
        if (!visionPipeline.isInitialized()) {
          try {
            await visionPipeline.initialize();
          } catch (initErr) {
            visionPipeline.recordOcr(false, 'init failed');
            return { ok: false, error: 'vision init failed: ' + String(initErr) };
          }
        }
        const result = await visionPipeline.processImage(screenshotResult.dataUrl, {
          task: 'ocr',
        });
        const text = result?.text ?? (result?.data as any)?.text ?? '';
        if (!text) {
          visionPipeline.recordOcr(false, 'empty ocr');
          return { ok: false, error: 'empty ocr' };
        }
        visionPipeline.recordOcr(true, 'ok');
        return { ok: true, text };
      } catch (e) {
        visionPipeline.recordOcr(false, String(e));
        return { ok: false, error: String(e) };
      }
    }

    // #136: the popup's VLM live indicator polls this. Pure status (no PII,
    // no pixels): is the on-device model ready / loading / unavailable,
    // and what did the last OCR check conclude?
    function getVisionStatus() {
      return visionPipeline.status();
    }

    /**
     * #141: cross-tab handoff harvest. Pull the page's labeled value
     * pairs (definition lists, label→input, two-cell table rows,
     * name/value lists) so the SW can carry them to a later tab as
     * <FIELD_N> tokens. The VALUES cross to the SW only - the planner
     * sees tokens + labels, and the executor resolves the value at
     * write time. Passwords are never harvested. Capped at 50 fields,
     * 200 chars per value (dense pages stay bounded).
     */
    function harvestFields(): Array<{ label: string; value: string }> {
      const out: Array<{ label: string; value: string }> = [];
      const seen = new Set<string>();
      const add = (label: string, value: string) => {
        const l = label.trim().replace(/\s+/g, ' ');
        const v = value.trim().replace(/\s+/g, ' ');
        if (!v || v.length > 200) return;
        const key = l + '→' + v;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label: l, value: v });
        if (out.length >= 50) return;
      };
      try {
        // 1) definition lists: <dt>label</dt><dd>value</dd>
        for (const dt of Array.from(document.querySelectorAll('dt'))) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === 'DD') add(dt.textContent || '', dd.textContent || '');
          if (out.length >= 50) break;
        }
        // 2) <label for=x>label</label> -> input/textarea#x
        for (const lab of Array.from(document.querySelectorAll('label[for]'))) {
          const target = document.getElementById(lab.getAttribute('for') || '');
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            const input = target as HTMLInputElement;
            if (input.type === 'password') continue;
            add(lab.textContent || '', input.value || '');
          }
          if (out.length >= 50) break;
        }
        // 3) two-cell table rows: <th>label</th><td>value</td>
        for (const tr of Array.from(document.querySelectorAll('tr'))) {
          const cells = Array.from(tr.children);
          if (cells.length >= 2) {
            const first = cells[0];
            const isLabelCell =
              first.tagName === 'TH' ||
              (first.tagName === 'TD' &&
                (first.getAttribute('role') === 'rowheader' ||
                  (first.className && /label/i.test(String(first.className)))));
            if (isLabelCell) {
              add(first.textContent || '', cells[1].textContent || '');
            }
          }
          if (out.length >= 50) break;
        }
        // 4) name/value text pairs: "Label: value" lines in list items /
        //    definition-like divs (the "Compliance report" shape).
        for (const li of Array.from(
          document.querySelectorAll('li, dd, .field, .data, [class*="kv"], [class*="row"]')
        )) {
          const text = li.textContent || '';
          const m = text.match(/^([\w\s-]{2,40}?):\s+(.{1,200})$/);
          if (m) add(m[1], m[2]);
          if (out.length >= 50) break;
        }
      } catch {
        /* harvest is best-effort; a broken page yields zero fields */
      }
      return out;
    }

    /**
     * Merge vision-detected bounding boxes with DOM-extracted elements.
     * Adds vision boxes as synthetic elements when DOM is insufficient.
     */
    function mergeVisionWithDOM(domElements: any[], visionResult: any): any[] {
      if (!visionResult?.boundingBoxes?.length) {
        return domElements;
      }

      const visionElements = visionResult.boundingBoxes.map((box: any, i: number) => ({
        id: domElements.length + i + 1,
        stableId: `vision_${i}`,
        tag: 'vision-box',
        type: null,
        role: 'text',
        label: box.label || `Element ${i + 1}`,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        interactive: false,
        isVisionBox: true,
      }));

      // Combine DOM elements with vision boxes
      return [...domElements, ...visionElements];
    }

    // Capture interactive elements for action targeting
    function captureInteractiveElements(): InteractiveElement[] {
      // Reuse extract() to get consistent IDs
      const extracted = extract();
      return extracted.map((el) => ({
        ...el,
        // Convert to the format expected by the old interface
        name: '',
        rect: { x: el.x, y: el.y, width: el.width, height: el.height },
        isPassword: false,
      }));
    }

    // Build simplified accessibility tree
    function buildAccessibilityTree(root: HTMLElement): ARIAElement[] {
      const nodes: ARIAElement[] = [];

      function traverse(node: Node, depth: number = 0) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const role = el.getAttribute('role') || getDefaultRole(el.tagName);

          if (role && role !== 'presentation' && role !== 'none') {
            nodes.push({
              role,
              name:
                el.getAttribute('aria-label') ||
                maskLabel(el.textContent?.trim().slice(0, 100)) ||
                '',
              expanded: el.getAttribute('aria-expanded') === 'true',
              checked: el.getAttribute('aria-checked') || undefined,
              required: el.getAttribute('aria-required') === 'true',
              disabled:
                ('disabled' in el && (el as HTMLInputElement).disabled) ||
                el.getAttribute('aria-disabled') === 'true',
              depth,
            });
          }
        }

        for (const child of node.childNodes) {
          traverse(child, depth + 1);
        }
      }

      traverse(root);
      return nodes;
    }

    function getDefaultRole(tag: string): string {
      const roleMap: Record<string, string> = {
        BUTTON: 'button',
        A: 'link',
        INPUT: 'textbox',
        SELECT: 'combobox',
        TEXTAREA: 'textbox',
        NAV: 'navigation',
        MAIN: 'main',
        HEADER: 'banner',
        FOOTER: 'contentinfo',
        ARTICLE: 'article',
        SECTION: 'region',
        DETAILS: 'group',
        SUMMARY: 'button',
      };
      return roleMap[tag.toUpperCase()] || '';
    }

    /**
     * Outline an element so the person can see where a detection came
     * from. Called when a row in the detections table is clicked.
     *
     * The overlay is a fixed-position div with no href, role or tabindex,
     * so captureInteractiveElements() and extract() will not pick it up as
     * a page element. pointer-events: none keeps it from swallowing clicks.
     */
    function highlight(selector: string): { ok: boolean; error?: string } {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch {
        return { ok: false, error: 'invalid selector' };
      }
      if (!el) return { ok: false, error: 'element not on page' };

      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

      // Read the rect after scrolling, or the box lands where the
      // element used to be.
      const rect = el.getBoundingClientRect();

      document.getElementById(HIGHLIGHT_ID)?.remove();

      const box = document.createElement('div');
      box.id = HIGHLIGHT_ID;
      box.style.cssText = [
        'position:fixed',
        `top:${rect.top - 3}px`,
        `left:${rect.left - 3}px`,
        `width:${rect.width + 6}px`,
        `height:${rect.height + 6}px`,
        'border:2px solid #C2413B',
        'border-radius:3px',
        'background:rgba(194,65,59,0.12)',
        'pointer-events:none',
        'z-index:2147483647',
      ].join(';');
      document.body.appendChild(box);

      setTimeout(() => box.remove(), HIGHLIGHT_MS);
      return { ok: true };
    }

    // Listen for messages from background script and the popup.
    // 'capturePage' is handled here rather than through a command
    // registration — WXT's ctx has no addCommand().
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      if (!isAgentRequest(message)) return;

      if (message.type === 'EXTRACT') {
        return Promise.resolve({
          ok: true,
          elements: extract(),
          context: getPageContext(),
        });
      }

      if (message.type === 'EXECUTE') {
        // Use resilient execution with circuit breaker
        const result = await executeWithResilience(message.action);
        if (!result.ok && message.action.targetId !== undefined) {
          circuitBreaker.recordFailure(message.action.targetId);
        } else if (result.ok && message.action.targetId !== undefined) {
          circuitBreaker.recordSuccess(message.action.targetId);
        }
        return result;
      }

      if (message.type === 'PING') {
        return Promise.resolve({ ok: true, url: location.href });
      }

      if (message.type === 'capturePage') {
        return Promise.resolve(captureDOM());
      }

      if (message.type === 'VISION_EXTRACT') {
        return Promise.resolve(extractWithVision());
      }

      if (message.type === 'VISION_OCR') {
        // Issue #100 confirm path: OCR the currently-visible screen and
        // return just the text. The screenshot is captured by the SW
        // and stays on-device; we run Florence-2 OCR locally and send
        // back plain OCR text (never the raw pixels, never a PII-heavy
        // DOM). If the model isn't ready / can't init, we report ok:false
        // so the caller falls back to the deterministic backstop.
        return Promise.resolve(ocrVisibleScreen());
      }

      if (message.type === 'HIGHLIGHT') {
        return Promise.resolve(highlight(message.selector));
      }

      if (message.type === 'CURSOR_THINKING') {
        // #132: the planner LLM round-trip takes seconds (reasoning
        // model). While it runs, the agent cursor breathes instead of
        // sitting frozen, so the wait reads as "thinking", not "dead".
        // Best-effort: if the overlay isn't on this page the call is
        // a no-op. Fire-and-forget - never block the message path.
        try {
          if (message.on) startThinkingPulse();
          else stopThinkingPulse();
        } catch {
          /* presentation layer - never fatal */
        }
        return Promise.resolve({ ok: true });
      }

      if (message.type === 'VISION_STATUS') {
        // #136: return the on-device VLM pipeline status for the popup
        // live indicator. Pure status - no pixels, no PII.
        return Promise.resolve({ ok: true, status: getVisionStatus() });
      }

      if (message.type === 'HARVEST_FIELDS') {
        // #141: label/value pairs of this tab for the cross-tab
        // handoff. Best-effort, capped; the SW turns them into
        // <FIELD_N> tokens. A chrome:// or broken page yields [].
        return Promise.resolve({ ok: true, fields: harvestFields() });
      }

      if (message.type === 'VISION_GROUND') {
        // #115: bridge the offscreen host's Florence-2 grounding boxes
        // (screenshot-pixel coords) back to real DOM nodes so the
        // executor can act on them by targetId. This is the PII-safe
        // half of the near-empty-DOM fallback: pixels stayed in the
        // offscreen worker; only box coords + label text cross here,
        // and labels are masked through registerGroundedElement()
        // exactly like a DOM label would be.
        const domRecords = extract(); // (re)populate the node registry
        const existingNodes: Element[] = domRecords
          .map((r) => getElementById(r.id))
          .filter((n): n is Element => !!n);
        const dpr = window.devicePixelRatio || 1;
        const bridged = bridgeGroundBoxes(document, message.boxes ?? [], dpr, existingNodes);
        const elements = bridged
          .map((b) => registerGroundedElement(b.el, b.label))
          .filter((e): e is NonNullable<typeof e> => !!e);
        return Promise.resolve({
          ok: true,
          elements,
          grounded: elements.length,
          boxes: message.boxes?.length ?? 0,
        });
      }

      return;
    });

    // Listen for PII scrubbing requests
    ctx.addEventListener(window, 'message', (event) => {
      if (event.data?.type === 'SCRUB_PII') {
        const scrubbed = piiDetector.scrubHTML(event.data.html);
        event.source?.postMessage({ type: 'SCRUBBED', html: scrubbed });
      }
    });

    // Dev-only console hook for manual testing from DevTools.
    // import.meta.env.DEV is false in production builds, so this whole
    // block is dead-code-eliminated and never ships.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__agent = {
        extract,
        execute: executeWithRetry,
        context: getPageContext,
        captureDOM,
        extractWithVision,
        highlight,
        piiDetector,
        visionPipeline,
      };
    }
  },
});

// PII Detection Engine
class PIIDetector {
  // Instance member, not static: every lookup below goes through `this`,
  // and `this.PATTERNS` is undefined on a static member.
  private readonly PATTERNS: Record<string, RegExp> = {
    // Indian PII
    AADHAAR: /^\d{4}\s?\d{4}\s?\d{4}$/u,
    PAN: /^[A-Z]{5}\d{4}[A-Z]{1}$/u,
    // 11 characters, not 12: a real IFSC is 4 letters + '0' + 6 alphanumerics.
    // The old {7} made this pattern unable to match any real IFSC (#163, #168).
    IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/u,
    PHONE: /^\+?[1-9]\d{9,11}$/u,
    EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,

    // International PII
    CREDIT_CARD: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/u,
    SSN: /^\d{3}-?\d{2}-?\d{4}$/u,

    // Sensitive content
    PASSWORD_FIELD: /password|passwd|pwd|pin/i,
    API_KEY: /api[_-]?key|apikey|access[_-]?token/i,
  };

  scanDocument(): DetectedPII[] {
    const detections: DetectedPII[] = [];

    // Scan input values
    document.querySelectorAll('input').forEach((input) => {
      const type = input.getAttribute('type')?.toLowerCase() || 'text';
      const name = input.getAttribute('name') || input.getAttribute('id') || '';

      if (type === 'password' || this.PATTERNS.PASSWORD_FIELD.test(name)) {
        detections.push({
          type: 'PASSWORD_FIELD',
          selector: this.getElementSelector(input),
          confidence: 0.99,
          isVerified: true,
          redacted: true,
        });
      } else if (input.value) {
        for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
          if (piiType === 'PASSWORD_FIELD') continue;
          if (pattern.test(input.value)) {
            detections.push(this.record(piiType, input.value, input));
          }
        }
      }
    });

    // Scan text content for PII — use exec() in a loop for non-anchored matches
    document.querySelectorAll('div, span, p, td, th, label').forEach((el) => {
      const text = el.textContent || '';
      for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
        if (piiType === 'PASSWORD_FIELD') continue;

        // Strip the anchors so the pattern can match anywhere in the
        // text. Remove both ^ and $ anchors.
        let source = pattern.source;
        if (source.startsWith('^')) source = source.slice(1);
        if (source.endsWith('$')) source = source.slice(0, -1);
        const scanPattern = new RegExp(source, pattern.flags.replace('u', 'gu'));

        let match: RegExpExecArray | null;
        while ((match = scanPattern.exec(text)) !== null) {
          detections.push(this.record(piiType, match[0], el));

          // A zero-length match would spin forever.
          if (match.index === scanPattern.lastIndex) scanPattern.lastIndex++;
        }
      }
    });

    return detections;
  }

  /**
   * Turn a match into a detection record.
   *
   * The raw value is used here and then dropped. It is never stored on the
   * record, not even truncated — the first four characters of an Aadhaar
   * number are four real digits, and this record is rendered in the privacy
   * panel and included in the export.
   *
   * The checksum has to run at this point for the same reason: once the
   * record exists there is no value left to validate. The old code ran it
   * afterwards on an already-masked string, so `isVerified` was always false.
   */
  private record(piiType: string, raw: string, el: Element): DetectedPII {
    const verified = this.checksumOk(piiType, raw);
    return {
      type: piiType as PIIType,
      selector: this.getElementSelector(el),
      confidence: this.getConfidence(piiType, verified),
      isVerified: verified,
      redacted: true,
    };
  }

  /** Run the type's checksum, where one exists. */
  private checksumOk(type: string, raw: string): boolean {
    if (type === 'AADHAAR') return this.verhoeffCheck(raw.replace(/[\s-]/g, ''));
    if (type === 'PAN') return this.validatePAN(raw.trim().toUpperCase());
    if (type === 'CREDIT_CARD') return this.luhnCheck(raw.replace(/[\s-]/g, ''));
    // No checksum exists for these — a pattern match is all we have.
    return false;
  }

  scrubHTML(html: string): string {
    let scrubbed = html;

    // Redact password fields
    scrubbed = scrubbed.replace(
      /(<input[^>]*type=["']password["'][^>]*)>/g,
      '$1 data-pii-redacted="true">'
    );
    scrubbed = scrubbed.replace(
      /(<input[^>]*name=["'][^"']*password[^"']*["'][^>]*)>/g,
      '$1 data-pii-redacted="true">'
    );

    // Mask detected PII values in text content — use global flag for multiple matches
    scrubbed = scrubbed.replace(/(\d{4}\s?\d{4}\s?\d{4})/g, 'XXX XXX XXX');

    scrubbed = scrubbed.replace(/([A-Z]{5}\d{4}[A-Z]{1})/g, 'XXXXX9999X');

    return scrubbed;
  }

  // Verhoeff algorithm for Aadhaar validation
  // Aadhaar check digit. The Verhoeff implementation lives in
  // src/lib/pii/validators.ts and is imported at the top of this file - it used
  // to be duplicated here with a wrong `p` table, which rejected ~90% of real
  // Aadhaar numbers (#168). Kept as a thin method so the call sites below are
  // unchanged.
  private verhoeffCheck(digits: string): boolean {
    return validateAadhaar(digits);
  }

  // PAN validation
  private validatePAN(pan: string): boolean {
    // Delegates to the single validator. The copy that used to live here
    // checked index 2 (the third letter) instead of index 3 (the entity-type
    // character), so it both rejected valid PANs whose third letter was not in
    // its list and accepted invalid entity types entirely.
    return validatePAN(pan);
  }

  // Luhn algorithm for credit cards
  private luhnCheck(number: string): boolean {
    if (number.length < 13 || number.length > 19) return false;

    let sum = 0;
    let isEven = false;

    for (let i = number.length - 1; i >= 0; i--) {
      let digit = parseInt(number[i], 10);

      if (isEven) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }

      sum += digit;
      isEven = !isEven;
    }

    return sum % 10 === 0;
  }

  /**
   * A pattern match and a checksum-confirmed match are very different levels
   * of certainty, so the score reflects which one this was.
   */
  private getConfidence(type: string, verified: boolean): number {
    if (verified) {
      const confirmed: Record<string, number> = {
        AADHAAR: 0.98,
        PAN: 0.95,
        CREDIT_CARD: 0.97,
      };
      return confirmed[type] ?? 0.9;
    }

    const patternOnly: Record<string, number> = {
      AADHAAR: 0.3,
      PAN: 0.2,
      CREDIT_CARD: 0.3,
      IFSC: 0.8,
      PHONE: 0.75,
      EMAIL: 0.95,
    };
    return patternOnly[type] ?? 0.7;
  }

  private getElementSelector(element: Element): string {
    if (element.id) return `#${element.id}`;
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/).slice(0, 2).join('.');
      return `${element.tagName.toLowerCase()}.${classes}`;
    }
    return element.tagName.toLowerCase();
  }
}

// Types
interface SanitizedDOMSnapshot {
  url: string;
  title: string;
  timestamp: number;
  accessibilityTree: ARIAElement[];
  interactiveElements: InteractiveElement[];
  detectedPII: DetectedPII[];
  // Page geometry + scroll affordance (issue #59). The background forwards
  // this to the popup, which forwards it to the planner so it knows whether
  // the form continues below the fold.
  context: import('../lib/dom').PageContext;
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

/**
 * A PII finding. There is deliberately no `value` field — the detector reads
 * the raw value to match and checksum it, then discards it.
 */
interface DetectedPII {
  type: string;
  selector: string;
  confidence: number;
  redacted: boolean;
  isVerified?: boolean;
}

type PIIType =
  | 'AADHAAR'
  | 'PAN'
  | 'CREDIT_CARD'
  | 'PHONE'
  | 'EMAIL'
  | 'IFSC'
  | 'SSN'
  | 'PASSWORD_FIELD'
  | 'API_KEY';

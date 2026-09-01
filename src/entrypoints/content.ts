import { defineContentScript } from 'wxt/sandbox';
import { browser } from 'wxt/browser';
import { extract, getPageContext } from '../lib/dom';
import { executeWithRetry } from '../lib/actions';

/**
 * Content Script - DOM Capture + PII Redaction + Action Execution
 *
 * This script runs in the page context and:
 * 1. Captures DOM structure and accessibility tree
 * 2. Detects and redacts PII before sending to server
 * 3. Executes actions (click, type, scroll) on elements
 * 4. Posts sanitized data to the background script
 */

// Messages the background worker can send us.
type AgentRequest =
    | { type: 'EXTRACT' }
    | { type: 'EXECUTE'; action: import('../lib/actions').Action }
    | { type: 'PING' }
    | { type: 'capturePage' }
    | { type: 'HIGHLIGHT'; selector: string };

function isAgentRequest(msg: unknown): msg is AgentRequest {
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return false;
    const t = (msg as { type: unknown }).type;
    return t === 'EXTRACT' || t === 'EXECUTE' || t === 'PING'
        || t === 'capturePage' || t === 'HIGHLIGHT';
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

            return {
                url: window.location.href,
                title: document.title,
                timestamp: Date.now(),
                // SECURITY: Never send raw HTML — it contains user input (passwords, Aadhaar, PAN)
                // Instead send sanitized interactive elements only
                accessibilityTree: a11yTree,
                interactiveElements,
                detectedPII: piiDetector.scanDocument(),
            };
        }

        // Capture interactive elements for action targeting
        function captureInteractiveElements(): InteractiveElement[] {
            const selectors = [
                'button', 'a[href]', 'input', 'select', 'textarea',
                '[role="button"]', '[role="link"]', '[role="textbox"]',
                '[tabindex]:not([tabindex="-1"])',
                'details summary', 'summary'
            ].join(', ');

            const elements = document.querySelectorAll(selectors) as NodeListOf<HTMLElement>;
            const result: InteractiveElement[] = [];

            elements.forEach((el, index) => {
                const rect = el.getBoundingClientRect();
                // Either dimension being zero means it isn't rendered.
                if (rect.width === 0 || rect.height === 0) return;

                // Annotate DOM with data-agent-id so background actions can find targets
                el.setAttribute('data-agent-id', String(index));

                result.push({
                    id: index,
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || el.tagName.toLowerCase(),
                    label: el.getAttribute('aria-label')
                        || el.getAttribute('placeholder')
                        || el.textContent?.trim().slice(0, 50)
                        || '',
                    name: el.getAttribute('name') || el.getAttribute('id') || '',
                    rect: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                    isPassword: el.getAttribute('type') === 'password',
                });
            });

            return result;
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
                            name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 100) || '',
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
                'BUTTON': 'button',
                'A': 'link',
                'INPUT': 'textbox',
                'SELECT': 'combobox',
                'TEXTAREA': 'textbox',
                'NAV': 'navigation',
                'MAIN': 'main',
                'HEADER': 'banner',
                'FOOTER': 'contentinfo',
                'ARTICLE': 'article',
                'SECTION': 'region',
                'DETAILS': 'group',
                'SUMMARY': 'button',
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
            let el: Element | null = null;
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
        browser.runtime.onMessage.addListener((message: unknown) => {
            if (!isAgentRequest(message)) return;

            if (message.type === 'EXTRACT') {
                return Promise.resolve({
                    ok: true,
                    elements: extract(),
                    context: getPageContext(),
                });
            }

            if (message.type === 'EXECUTE') {
                return executeWithRetry(message.action);
            }

            if (message.type === 'PING') {
                return Promise.resolve({ ok: true, url: location.href });
            }

            if (message.type === 'capturePage') {
                return Promise.resolve(captureDOM());
            }

            if (message.type === 'HIGHLIGHT') {
                return Promise.resolve(highlight(message.selector));
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
                highlight,
                piiDetector,
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
        IFSC: /^[A-Z]{4}0[A-Z0-9]{7}$/u,
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
        document.querySelectorAll('input').forEach(input => {
            const type = input.getAttribute('type')?.toLowerCase() || 'text';
            const name = input.getAttribute('name') || input.getAttribute('id') || '';

            if (type === 'password' || this.PATTERNS.PASSWORD_FIELD.test(name)) {
                detections.push({
                    type: 'PASSWORD_FIELD',
                    selector: this.getElementSelector(input),
                    confidence: 0.99,
                    redacted: true,
                });
            } else if (input.value) {
                for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
                    if (piiType === 'PASSWORD_FIELD') continue;
                    if (pattern.test(input.value)) {
                        detections.push({
                            type: piiType as PIIType,
                            value: piiType === 'CREDIT_CARD' ? this.maskCard(input.value) : input.value.slice(0, 4) + '***',
                            selector: this.getElementSelector(input),
                            confidence: this.getConfidence(piiType, input.value),
                            redacted: true,
                        });
                    }
                }
            }
        });

        // Scan text content for PII — use exec() in a loop for non-anchored matches
        document.querySelectorAll('div, span, p, td, th, label').forEach(el => {
            const text = el.textContent || '';
            for (const [piiType, pattern] of Object.entries(this.PATTERNS)) {
                if (piiType === 'PASSWORD_FIELD') continue;

                // Strip the anchors so the pattern can match anywhere in the
                // text. The trailing anchor needs escaping — a bare `$` in the
                // search pattern means "end of string", so it never matched the
                // literal `$` character and the anchor was left in place.
                const source = pattern.source.replace(/^\^/, '').replace(/\$$/, '');
                const scanPattern = new RegExp(source, pattern.flags.replace('u', 'gu'));

                let match: RegExpExecArray | null;
                while ((match = scanPattern.exec(text)) !== null) {
                    detections.push({
                        type: piiType as PIIType,
                        value: piiType === 'CREDIT_CARD' ? this.maskCard(match[0]) : match[0].slice(0, 4) + '***',
                        selector: this.getElementSelector(el),
                        confidence: this.getConfidence(piiType, match[0]),
                        redacted: true,
                    });

                    // A zero-length match would spin forever.
                    if (match.index === scanPattern.lastIndex) scanPattern.lastIndex++;
                }
            }
        });

        // Run specialized validators
        this.validateAndRefine(detections);

        return detections;
    }

    scrubHTML(html: string): string {
        let scrubbed = html;

        // Redact password fields
        scrubbed = scrubbed.replace(/(<input[^>]*type=["']password["'][^>]*)>/g, '$1 data-pii-redacted="true">');
        scrubbed = scrubbed.replace(/(<input[^>]*name=["'][^"']*password[^"']*["'][^>]*)>/g, '$1 data-pii-redacted="true">');

        // Mask detected PII values in text content — use global flag for multiple matches
        scrubbed = scrubbed.replace(
            /(\d{4}\s?\d{4}\s?\d{4})/g,
            'XXX XXX XXX'
        );

        scrubbed = scrubbed.replace(
            /([A-Z]{5}\d{4}[A-Z]{1})/g,
            'XXXXX9999X'
        );

        return scrubbed;
    }

    private validateAndRefine(detections: DetectedPII[]): void {
        // Aadhaar: Verhoeff checksum validation
        detections.forEach(d => {
            if (d.type === 'AADHAAR') {
                const digits = d.value?.replace(/\s/g, '') || '';
                d.isVerified = this.verhoeffCheck(digits);
                d.confidence = d.isVerified ? 0.98 : 0.3;
            }
            if (d.type === 'PAN') {
                d.isVerified = this.validatePAN(d.value || '');
                d.confidence = d.isVerified ? 0.95 : 0.2;
            }
            if (d.type === 'CREDIT_CARD') {
                const digits = d.value?.replace(/[\s-]/g, '') || '';
                d.isVerified = this.luhnCheck(digits);
                d.confidence = d.isVerified ? 0.97 : 0.3;
            }
        });
    }

    // Verhoeff algorithm for Aadhaar validation
    private verhoeffCheck(digits: string): boolean {
        if (digits.length !== 12) return false;
        if (!/^\d{12}$/.test(digits)) return false;

        const d = [
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
            [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
            [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
            [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
            [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
            [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
            [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
            [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
            [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
        ];

        const p = [
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
            [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
            [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
            [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
            [5, 0, 9, 8, 7, 4, 3, 2, 1, 6],
            [6, 0, 8, 7, 5, 2, 1, 3, 4, 9],
            [7, 0, 5, 6, 8, 3, 4, 2, 9, 1],
            [8, 0, 3, 4, 5, 9, 6, 1, 2, 7],
            [9, 0, 2, 1, 3, 8, 7, 4, 6, 5],
        ];

        let checksum = 0;
        const reversed = digits.split('').reverse().map(Number);

        for (let i = 0; i < reversed.length - 1; i++) {
            checksum = d[checksum][p[i % 8][reversed[i]]];
        }

        return checksum === reversed[reversed.length - 1];
    }

    // PAN validation
    private validatePAN(pan: string): boolean {
        if (!/^[A-Z]{5}\d{4}[A-Z]{1}$/.test(pan)) return false;

        const chars = pan.split('');
        // Third character indicates entity type
        const entityTypes = ['C', 'P', 'H', 'F', 'C', 'T', 'A', 'J', 'G', 'L'];
        if (!entityTypes.includes(chars[2])) return false;

        return true;
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

    private maskCard(card: string): string {
        const digits = card.replace(/\s|-/g, '');
        return digits.slice(0, 4) + ' **** **** ' + digits.slice(-4);
    }

    private getConfidence(type: string, _value: string): number {
        const baseConfidence: Record<string, number> = {
            AADHAAR: 0.85,
            PAN: 0.90,
            CREDIT_CARD: 0.85,
            IFSC: 0.80,
            PHONE: 0.75,
            EMAIL: 0.95,
        };
        return baseConfidence[type] || 0.7;
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

type PIIType = 'AADHAAR' | 'PAN' | 'CREDIT_CARD' | 'PHONE' | 'EMAIL' | 'IFSC' | 'SSN' | 'PASSWORD_FIELD' | 'API_KEY';
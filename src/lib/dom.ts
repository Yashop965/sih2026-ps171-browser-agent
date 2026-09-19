// src/lib/dom.ts
// DOM extraction engine — finds every interactive element on the page
// and returns clean metadata. Never reads element values (that would be PII).

export interface ExtractedElement {
    id: number;
    // Stable identifier based on position and label - doesn't change when DOM re-renders
    stableId: string;
    tag: string;
    type: string | null;
    role: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    interactive: boolean;
}

const SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[onclick]',
    '[contenteditable="true"]',
    // Note: labels are intentionally excluded - they're not interactive form controls
].join(',');

// Map of id -> real DOM node. The executor (#9) uses this to act on elements.
// Rebuilt on every extract() call.
const registry = new Map<number, Element>();
// Map of stableId -> real DOM node for persistent element tracking
const stableIdRegistry = new Map<string, Element>();

export function getElementById(id: number): Element | undefined {
    return registry.get(id);
}

export function getElementByStableId(stableId: string): Element | undefined {
    return stableIdRegistry.get(stableId);
}

function isVisible(el: Element, rect: DOMRect): boolean {
    if (rect.width < 2 || rect.height < 2) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) < 0.05) return false;

    // #117: visually-present controls inside aria-hidden="true" or inert
    // subtrees are semantically off-limits (decorative mirrors, disabled
    // sections, hidden drawers). They still pass the display/opacity checks
    // above and become trap targets, so exclude them. An unknown attribute
    // in the selector simply matches nothing on browsers without `inert`
    // support (Firefox < 112), so this degrades to a no-op there.
    try {
        if (el.closest('[aria-hidden="true"],[inert]')) return false;
    } catch {
        // closest() can only throw in a broken DOM state; never block
        // extraction on that.
    }

    // Fully outside the viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    if (rect.right < 0 || rect.left > window.innerWidth) return false;

    return true;
}

// --- Label sanitisation -----------------------------------------------------
//
// We never read element.value, so what the user typed never leaves. But a page
// can print PII into its own markup — a portal showing "Aadhaar: 2345 6789
// 0123" inside a link, or a confirmation screen echoing a card number. That
// text is textContent, which labels do read, so it gets masked on the way out.
//
// This runs on every label without exception. There is no "is this element
// sensitive" branch: a rule that applies to everything cannot be bypassed by
// misclassifying one element.

const LABEL_PII: Array<{ re: RegExp; tag: string }> = [
    // Order matters. Longer numeric patterns run first, otherwise a shorter
    // rule consumes part of a longer number and leaves the tail exposed —
    // the Aadhaar rule would eat the first 12 digits of a 16-digit card and
    // leave "1111" in the clear.

    // Card numbers: 13–19 digits, optionally spaced or hyphenated
    { re: /\b\d(?:[\s-]?\d){12,18}\b/g, tag: '[CARD]' },
    // Aadhaar: 12 digits, optionally grouped in fours
    { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, tag: '[AADHAAR]' },
    // PAN: five letters, four digits, one letter
    { re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, tag: '[PAN]' },
    // IFSC: four letters, a zero, six alphanumerics
    { re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, tag: '[IFSC]' },
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, tag: '[EMAIL]' },
    // Indian mobile numbers, with or without country code
    { re: /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g, tag: '[PHONE]' },
];

function maskLabel(text: string): string {
    let out = text;
    for (const { re, tag } of LABEL_PII) {
        re.lastIndex = 0; // these are module-level and /g, so reset before reuse
        out = out.replace(re, tag);
    }
    return out;
}

export { maskLabel };

/** Every label leaves through here. Trim, mask, cap. */
function clean(text: string): string {
    return maskLabel(text.trim()).slice(0, 80);
}

// Work out what to call this element, in order of trustworthiness.
// Never falls back to element.value — that could be the user's Aadhaar number.
function getLabel(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);

    // aria-labelledby may list several ids separated by whitespace; the label
    // is the concatenation of all of them, in order.
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
        const parts = labelledBy
            .split(/\s+/)
            .filter(Boolean)
            .map((refId) => document.getElementById(refId)?.textContent?.trim())
            .filter(Boolean);

        if (parts.length) return clean(parts.join(' '));
    }

    if (el.id) {
        // CSS.escape is absent in some DOM implementations (notably jsdom);
        // fall back to the raw id so a label reference still resolves there.
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
        const forLabel = document.querySelector(`label[for="${escaped}"]`);
        if (forLabel?.textContent) return clean(forLabel.textContent);
    }

    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent) return clean(wrappingLabel.textContent);

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);

    const title = el.getAttribute('title');
    if (title) return clean(title);

    const alt = el.getAttribute('alt');
    if (alt) return clean(alt);

    // Buttons and links usually carry their own text
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
        const text = el.textContent?.trim();
        if (text) return clean(text);
    }

    if (el instanceof HTMLInputElement) {
        const inputType = el.type;
        if (inputType === 'submit' || inputType === 'button') {
            // Safe here: submit button labels are static UI text, not user data.
            // Masked anyway — a page is free to put anything in that attribute.
            const val = el.value;
            if (val) return clean(val);
        }
        return `${inputType} field`;
    }

    return tag;
}

function getRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el instanceof HTMLInputElement) {
        const t = el.type;
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        return 'textbox';
    }
    return 'generic';
}

function isDisabled(el: Element): boolean {
    if ('disabled' in el && (el as HTMLInputElement).disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
}

export function extract(): ExtractedElement[] {
    const started = performance.now();
    registry.clear();
    stableIdRegistry.clear();

    const nodes = Array.from(document.querySelectorAll(SELECTORS));
    const results: ExtractedElement[] = [];
    let nextId = 1;

    for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;

        const id = nextId++;
        const label = getLabel(el);
        // Content-invariant stable ID (issue #62). Previously this was
        // `${label}_${rect.left}_${rect.top}` — screen coordinates — so the
        // same element got a *different* stableId after any scroll. That
        // broke the "already filled" tracking across scroll/re-extract, which
        // is exactly what a scroll-to-reveal form walk needs. Now the id is
        // built from what the element *is* (tag + name/for + role + label +
        // its ordinal among same-kind siblings), never where it is on screen.
        const nameAttr = el.getAttribute?.('name') || '';
        const forAttr = el.getAttribute?.('for') || '';
        const kind = el.tagName.toLowerCase();
        const stableId = [
            kind,
            nameAttr || forAttr,
            getRole(el),
            label.replace(/\s+/g, '_').slice(0, 30) || 'unnamed',
        ].join('|');

        registry.set(id, el);
        stableIdRegistry.set(stableId, el);

        results.push({
            id,
            stableId,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type'),
            role: getRole(el),
            label,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            interactive: !isDisabled(el),
        });
    }

    const elapsed = performance.now() - started;
    if (elapsed > 10) {
        console.warn(`[dom] extraction took ${elapsed.toFixed(1)}ms (budget: 10ms)`);
    }

    return results;
}

export interface PageContext {
    url: string;
    title: string;
    scrollY: number;
    scrollHeight: number;
    viewport: { width: number; height: number };
    // True when the document has content below the current viewport. This is
    // the single signal the planner needs to decide "scroll to reveal more
    // fields". Without it the model only ever sees visible elements and has no
    // idea the form continues (issue #59).
    moreContentBelow: boolean;
}

export function getPageContext(): PageContext {
    // 4px epsilon so a page scrolled flush to the bottom doesn't report
    // "more below" and cause an endless scroll.
    const bottom = Math.round(window.scrollY + window.innerHeight);
    const height = Math.round(document.body.scrollHeight);
    return {
        url: location.href,
        title: document.title,
        scrollY: Math.round(window.scrollY),
        scrollHeight: height,
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
        },
        moreContentBelow: bottom < height - 4,
    };
}

// src/lib/dom.ts
// DOM extraction engine — finds every interactive element on the page
// and returns clean metadata. Never reads element values (that would be PII).

export interface ExtractedElement {
    id: number;
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
].join(',');

// Map of id -> real DOM node. The executor (#9) uses this to act on elements.
// Rebuilt on every extract() call.
const registry = new Map<number, Element>();

export function getElementById(id: number): Element | undefined {
    return registry.get(id);
}

function isVisible(el: Element, rect: DOMRect): boolean {
    if (rect.width < 2 || rect.height < 2) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) < 0.05) return false;

    // Fully outside the viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    if (rect.right < 0 || rect.left > window.innerWidth) return false;

    return true;
}

// Work out what to call this element, in order of trustworthiness.
// Never falls back to element.value — that could be the user's Aadhaar number.
function getLabel(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
        const source = document.getElementById(labelledBy);
        if (source?.textContent) return source.textContent.trim().slice(0, 80);
    }

    if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel?.textContent) return forLabel.textContent.trim().slice(0, 80);
    }

    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim().slice(0, 80);

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title) return title.trim();

    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();

    // Buttons and links usually carry their own text
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
        const text = el.textContent?.trim();
        if (text) return text.slice(0, 80);
    }

    if (tag === 'input') {
        const inputType = (el as HTMLInputElement).type;
        if (inputType === 'submit' || inputType === 'button') {
            const val = (el as HTMLInputElement).value;
            // Safe here: submit button labels are static UI text, not user data
            if (val) return val.trim().slice(0, 80);
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
    if (tag === 'input') {
        const t = (el as HTMLInputElement).type;
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        return 'textbox';
    }
    return 'generic';
}

function isDisabled(el: Element): boolean {
    if ((el as HTMLInputElement).disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
}

export function extract(): ExtractedElement[] {
    const started = performance.now();
    registry.clear();

    const nodes = Array.from(document.querySelectorAll(SELECTORS));
    const results: ExtractedElement[] = [];
    let nextId = 1;

    for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;

        const id = nextId++;
        registry.set(id, el);

        results.push({
            id,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type'),
            role: getRole(el),
            label: getLabel(el),
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

export function getPageContext() {
    return {
        url: location.href,
        title: document.title,
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.body.scrollHeight),
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
        },
    };
}

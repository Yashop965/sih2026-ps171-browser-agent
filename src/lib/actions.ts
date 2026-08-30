// src/lib/actions.ts
// Takes an action from the planner server and performs it on the page.

import { getElementById } from './dom';

export interface Action {
    type: 'CLICK' | 'TYPE' | 'SCROLL' | 'SELECT' | 'NAVIGATE' | 'DONE';
    targetId?: number;
    value?: string;
    scrollDirection?: 'up' | 'down' | 'left' | 'right';
    scrollAmount?: number;
    url?: string;
}

export interface ActionResult {
    ok: boolean;
    action: Action;
    error?: string;
    durationMs: number;
}

const ACTION_TIMEOUT_MS = 5000;

// Returns Element, not HTMLElement. The registry legitimately holds SVG icon
// buttons, so every caller below checks before using HTMLElement-only methods.
function resolve(targetId: number | undefined): Element {
    if (targetId === undefined) {
        throw new Error('targetId missing');
    }
    const el = getElementById(targetId);
    if (!el) {
        throw new Error(`element ${targetId} not found — page may have changed`);
    }
    return el;
}

function scrollIntoView(el: Element) {
    const rect = el.getBoundingClientRect();
    const offscreen = rect.top < 0 || rect.bottom > window.innerHeight;
    if (offscreen) {
        // 'instant' is deliberate. 'auto' honours the page's own
        // scroll-behavior: smooth, which animates the scroll and lets the next
        // action fire before the element has arrived.
        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    }
}

// React (and Vue) keep their own copy of an input's value. Setting
// element.value directly updates the DOM but React never notices, so the
// field looks filled while React still thinks it is empty and submit fails.
// Calling the native setter bypasses React's override, and the bubbling
// 'input' event then tells React to sync.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
        el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
        setter.call(el, value);
    } else {
        el.value = value;
    }
}

function doClick(action: Action) {
    const el = resolve(action.targetId);
    scrollIntoView(el);

    if (el instanceof HTMLElement) {
        el.focus();
    }

    // Real mouse sequence — some sites listen for mousedown, not click.
    // dispatchEvent works on any Element, including SVG.
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
}

function doType(action: Action) {
    const el = resolve(action.targetId);
    const value = action.value ?? '';

    scrollIntoView(el);

    if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return;
    }

    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        throw new Error(`cannot TYPE into <${el.tagName.toLowerCase()}>`);
    }

    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function doSelect(action: Action) {
    const el = resolve(action.targetId);

    if (!(el instanceof HTMLSelectElement)) {
        throw new Error(`element ${action.targetId} is not a <select>`);
    }

    scrollIntoView(el);

    const wanted = (action.value ?? '').toLowerCase().trim();
    const match = Array.from(el.options).find(
        (o) =>
            o.value.toLowerCase() === wanted ||
            o.text.toLowerCase().trim() === wanted
    );

    if (!match) {
        throw new Error(`no option matching "${action.value}"`);
    }

    el.value = match.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function doScroll(action: Action) {
    const amount = action.scrollAmount ?? 400;
    const dir = action.scrollDirection ?? 'down';

    const delta = {
        down: { top: amount, left: 0 },
        up: { top: -amount, left: 0 },
        right: { top: 0, left: amount },
        left: { top: 0, left: -amount },
    }[dir];

    // See note in scrollIntoView — 'instant' avoids animated scrolling.
    window.scrollBy({ ...delta, behavior: 'instant' as ScrollBehavior });
}

function doNavigate(action: Action) {
    if (!action.url) throw new Error('url missing');
    // Only http(s) — never javascript: URLs
    const target = new URL(action.url, location.href);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`refused protocol: ${target.protocol}`);
    }
    location.assign(target.href);
}

export async function execute(action: Action): Promise<ActionResult> {
    const started = performance.now();

    const run = async () => {
        switch (action.type) {
            case 'CLICK': doClick(action); break;
            case 'TYPE': doType(action); break;
            case 'SELECT': doSelect(action); break;
            case 'SCROLL': doScroll(action); break;
            case 'NAVIGATE': doNavigate(action); break;
            case 'DONE': break;
            default:
                throw new Error(`unknown action type: ${(action as Action).type}`);
        }
        // Let the page react before we report success
        await new Promise((r) => setTimeout(r, 120));
    };

    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('action timed out')), ACTION_TIMEOUT_MS)
    );

    try {
        await Promise.race([run(), timeout]);
        return { ok: true, action, durationMs: performance.now() - started };
    } catch (err) {
        return {
            ok: false,
            action,
            error: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - started,
        };
    }
}

// One retry, because a click often fails only because the page was still
// settling from the previous action.
export async function executeWithRetry(action: Action): Promise<ActionResult> {
    const first = await execute(action);
    if (first.ok || action.type === 'NAVIGATE' || action.type === 'DONE') {
        return first;
    }
    await new Promise((r) => setTimeout(r, 400));
    return execute(action);
}
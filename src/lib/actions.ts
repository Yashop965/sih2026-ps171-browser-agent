// src/lib/actions.ts
// Takes an action from the planner server and performs it on the page.

import { getElementById, getElementByStableId } from './dom';

export interface Action {
    type: 'CLICK' | 'TYPE' | 'SCROLL' | 'SELECT' | 'NAVIGATE' | 'WAIT' | 'KEY' | 'DONE';
    // Can be either numeric ID or stableId string
    targetId?: number | string;
    value?: string;
    scrollDirection?: 'up' | 'down' | 'left' | 'right';
    scrollAmount?: number;
    url?: string;
    // WAIT: how long to let the page settle (ms). Autonomy primitive so the
    // agent can pause for content to load / appear before re-extracting.
    waitMs?: number;
    // KEY: the key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown",
    // or a single printable character). Issue #84: without this the agent
    // can TYPE into a search box but never submit it.
    key?: string;
}

export interface ActionResult {
    ok: boolean;
    action: Action;
    error?: string;
    durationMs: number;
    // Issue #64: true when the failure is a stale / not-found element. The
    // target is gone from the DOM (page re-rendered / navigated), so re-acting
    // on the same id can never succeed - the caller must re-extract to
    // re-register elements instead of retrying the dead id.
    stale?: boolean;
}

const ACTION_TIMEOUT_MS = 5000;

// Returns Element, not HTMLElement. The registry legitimately holds SVG icon
// buttons, so every caller below checks before using HTMLElement-only methods.
function resolve(targetId: number | string | undefined): Element {
    if (targetId === undefined) {
        throw new Error('targetId missing');
    }
    let el: Element | undefined;
    // Support both numeric IDs and stableId strings
    if (typeof targetId === 'number') {
        el = getElementById(targetId);
    } else {
        el = getElementByStableId(targetId as string);
    }
    if (!el) {
        console.warn(`[agent] Element ${targetId} not found in registry`);
        throw new Error(`element ${targetId} not found — page may have changed`);
    }
    // Staleness check: the page may have re-rendered between extract() and
    // execute(), leaving us holding a node that is no longer in the document.
    // Acting on it would silently do nothing, so fail loudly instead and let
    // the planner re-extract.
    if (!el.isConnected) {
        console.warn(`[agent] Element ${targetId} is stale (not connected to DOM)`);
        throw new Error(`element ${targetId} is stale — page changed since extract()`);
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

    // Prefer the native click(). It runs the element's real activation
    // behaviour — following an <a href>, submitting a form, toggling a
    // checkbox — which a synthetic MouseEvent does not always trigger.
    // Both HTMLElement and SVGElement have click(); anything else falls
    // back to a dispatched event.
    if (typeof (el as HTMLElement).click === 'function') {
        (el as HTMLElement).click();
    } else {
        el.dispatchEvent(new MouseEvent('click', opts));
    }
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

// KEY: press a keyboard key. This is the primitive that lets the agent
// SUBMIT a search box after TYPE-ing into it (Wikipedia, Google, most
// autocomplete search) - without it the agent can fill a field but never
// fire the Enter that the page is waiting for. Issue #84.
//
// A key is a full down → (keypress, for printable) → up triple on the target
// element (the focused one when targetId is omitted). Browsers and most form
// handlers listen on keydown for submit-on-Enter, so a real triple (not just
// a bare 'keydown') is what actually triggers the submit.
const KEY_MAP: Record<string, { code: string; keyCode: number; key: string; printable?: boolean }> = {
    Enter: { code: 'Enter', keyCode: 13, key: 'Enter', printable: true },
    Tab: { code: 'Tab', keyCode: 9, key: 'Tab' },
    Escape: { code: 'Escape', keyCode: 27, key: 'Escape' },
    Backspace: { code: 'Backspace', keyCode: 8, key: 'Backspace' },
    Delete: { code: 'Delete', keyCode: 46, key: 'Delete' },
    Space: { code: 'Space', keyCode: 32, key: ' ', printable: true },
    ArrowUp: { code: 'ArrowUp', keyCode: 38, key: 'ArrowUp' },
    ArrowDown: { code: 'ArrowDown', keyCode: 40, key: 'ArrowDown' },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37, key: 'ArrowLeft' },
    ArrowRight: { code: 'ArrowRight', keyCode: 39, key: 'ArrowRight' },
    Home: { code: 'Home', keyCode: 36, key: 'Home' },
    End: { code: 'End', keyCode: 35, key: 'End' },
};

function doKey(action: Action) {
    const name = (action.key ?? 'Enter').trim();
    if (!name) throw new Error('key missing');

    // Resolve target: explicit element, else whatever currently has focus,
    // else the body (so a key still lands somewhere meaningful).
    let target: Element | null = null;
    if (action.targetId !== undefined) {
        target = resolve(action.targetId);
        scrollIntoView(target);
        if (target instanceof HTMLElement) target.focus();
    }
    target = target ?? document.activeElement ?? document.body;

    // Named key, or a single printable character the LLM asked for.
    let spec = KEY_MAP[name];
    if (!spec && name.length === 1) {
        const c = name;
        // Physical `code` uses the UPPERCASE letter ("KeyA" for 'a' or 'A').
        // Real browsers compute `code` from the physical key, but a synthetic
        // KeyboardEvent only carries what we put in it — so always emit the
        // physical form rather than letting the char fall through to `key`.
        const isLetter = c.length === 1 && /[a-zA-Z]/.test(c);
        const isDigit = c.length === 1 && /[0-9]/.test(c);
        const code = isLetter
            ? `Key${c.toUpperCase()}`
            : isDigit
                ? `Digit${c}`
                : c; // symbols/space keep their single-char physical code
        spec = {
            code,
            keyCode: c.toUpperCase().charCodeAt(0),
            key: c,
            printable: true,
        };
    }
    if (!spec) {
        throw new Error(`unknown key: ${name} (use a named key like "Enter" or a single character)`);
    }

    // NOTE: no `view` / `which` in the init — some DOM implementations
    // (jsdom, and strict engines) reject a KeyboardEventInit whose `view` is
    // not their own Window object. keydown handlers never read `view` for
    // form submission, so dropping it is safe.
    const base = {
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        bubbles: true,
        cancelable: true,
    };

    // A full key sequence so handlers that watch for 'keypress' on printable
    // characters (some legacy form code) also fire.
    target.dispatchEvent(new KeyboardEvent('keydown', base));
    if (spec.printable) {
        target.dispatchEvent(new KeyboardEvent('keypress', base));
    }
    target.dispatchEvent(new KeyboardEvent('keyup', base));
}

// WAIT: let the page settle (content loading, a spinner finishing, a modal
// opening) before the agent re-extracts and re-plans. This is what turns the
// agent from a blind one-shot form filler into something that can operate on
// pages that change over time. Capped so a runaway/absent value can't wedge
// the whole run.
function doWait(action: Action) {
    const requested = Number.isFinite(action.waitMs) ? (action.waitMs as number) : 1000;
    const ms = Math.min(Math.max(requested, 0), 30_000); // clamp to [0, 30s]
    // Return a promise that resolves after ms; the executor's surrounding
    // 5s action timeout still applies to non-wait actions, so WAIT is exempted
    // in execute() below by awaiting the returned promise directly.
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
            case 'WAIT': await doWait(action); break;
            case 'KEY': doKey(action); break;
            case 'DONE': break;
            default:
                throw new Error(`unknown action type: ${(action as Action).type}`);
        }
        // Let the page react before we report success. WAIT already yielded
        // for its full duration, so skip the extra settle for it.
        if (action.type !== 'WAIT') {
            await new Promise((r) => setTimeout(r, 120));
        }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Per-action timeout. Most actions are fast (scroll/typing settle in
    // well under a second); WAIT is the deliberate exception, where the whole
    // point is to sleep. Give WAIT a bound that matches its requested
    // duration (clamped to the same [0, 30s] window doWait uses) plus a
    // small margin, so a 10s wait isn't killed by the default 5s race.
    const bound = action.type === 'WAIT'
        ? Math.min(Math.max(Number.isFinite(action.waitMs) ? (action.waitMs as number) : 1000, 0), 30_000) + 500
        : ACTION_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('action timed out')), bound);
    });

    try {
        await Promise.race([run(), timeout]);
        return { ok: true, action, durationMs: performance.now() - started };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Issue #64: distinguish a dead-element failure (the element is gone
        // from the DOM - resolve() threw "not found" / "stale") from a
        // transient one. Re-acting on the same id can never fix a dead
        // element; the caller must re-extract to re-register elements.
        return {
            ok: false,
            action,
            error,
            durationMs: performance.now() - started,
            stale: isStaleElementError(error),
        };
    } finally {
        // Without this every action leaves a live 5s timer behind.
        if (timer !== undefined) clearTimeout(timer);
    }
}

// Issue #64: true when the error means the target element no longer exists in
// the DOM. These come from resolve() ("not found" / "stale") and from a
// selector that matched nothing. A time-out / "cannot TYPE into <x>" error is
// NOT stale - the element is fine, the action just didn't work this time.
function isStaleElementError(message: string): boolean {
    const m = message.toLowerCase();
    return (
        m.includes('not found') ||
        m.includes('stale') ||
        m.includes('page may have changed') ||
        m.includes('page changed since extract')
    );
}

export async function executeWithRetry(action: Action): Promise<ActionResult> {
    const first = await execute(action);
    // NAVIGATE leaves the page (retries would re-run a navigation), DONE is a
    // terminal signal, WAIT already slept for its requested duration, and KEY
    // presses a key that may have navigated / shifted focus (re-pressing
    // would double-submit or re-focus). None of them benefit from an
    // automatic retry.
    if (first.ok || action.type === 'NAVIGATE' || action.type === 'DONE' || action.type === 'WAIT' || action.type === 'KEY') {
        return first;
    }
    // Issue #64: a stale / not-found target can't be fixed by re-acting on the
    // same id. Return immediately (with stale=true) so the caller re-extracts.
    if (first.stale) {
        return first;
    }
    await new Promise((r) => setTimeout(r, 400));
    return execute(action);
}

// Exponential backoff with circuit breaker
export async function executeWithResilience(
    action: Action,
    maxRetries: number = 3
): Promise<ActionResult> {
    const results: ActionResult[] = [];
    let lastError: string | undefined;

    for (let i = 0; i < maxRetries; i++) {
        const result = await execute(action);
        results.push(result);

        if (result.ok) {
            return result;
        }

        lastError = result.error;

        // Issue #64: a stale / not-found element will never come back by
        // re-acting on the same id. Stop the loop immediately and let the
        // planner re-extract (which re-registers elements) instead of
        // burning the full backoff on a dead target.
        if (result.stale) {
            break;
        }

        // Exponential backoff: 200ms, 400ms, 800ms
        await delay(Math.pow(2, i) * 200);
    }

    // All retries failed (or we short-circuited on a stale element).
    return {
        ok: false,
        action,
        error: lastError ?? 'Max retries exceeded',
        durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
        stale: results.some((r) => r.stale),
    };
}

// Circuit breaker: tracks consecutive failures per element
export class CircuitBreaker {
    private failures = new Map<string, number>();
    private readonly threshold = 3;
    private readonly resetMs = 30_000;

    shouldAct(targetId: number | string): boolean {
        const key = String(targetId);
        const count = this.failures.get(key) ?? 0;
        if (count >= this.threshold) {
            const failedAt = this.failures.get(`${key}:time`) as number | undefined;
            if (failedAt && Date.now() - failedAt < this.resetMs) {
                console.warn(`[agent] Circuit breaker open for element ${key}`);
                return false;
            }
            // Reset after timeout
            this.failures.delete(key);
            this.failures.delete(`${key}:time`);
        }
        return true;
    }

    recordFailure(targetId: number | string): void {
        const key = String(targetId);
        const count = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, count);
        this.failures.set(`${key}:time`, Date.now());
    }

    recordSuccess(targetId: number | string): void {
        const key = String(targetId);
        this.failures.delete(key);
        this.failures.delete(`${key}:time`);
    }

    reset(): void {
        this.failures.clear();
    }
}

// Singleton circuit breaker instance
export const circuitBreaker = new CircuitBreaker();

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
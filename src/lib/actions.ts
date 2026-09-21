// src/lib/actions.ts
// Takes an action from the planner server and performs it on the page.

import {
    getElementById,
    getElementByStableId,
    getGuardForId,
    getGuardForStableId,
    verifyElementFreshness,
} from './dom';
import { showCursor, hideCursor, type CursorActionKind } from './agentCursor';

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
    // #116: true when the target existed but was covered by another element
    // (cookie banner, sticky header, modal) at the moment of the hit-test,
    // so no input was dispatched. Like `stale`, re-acting on the same id
    // cannot fix it - the planner must dismiss the overlay and re-extract.
    covered?: boolean;
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

    // #118: semantic freshness. isConnected only proves the NODE survived; a
    // re-render that rewrites the surrounding context (the form section the
    // planner saw) leaves a live node that now means something else. The
    // masked guard captured at extract() time is re-read just before acting,
    // and a mismatch is reported as stale - the planner re-extracts. Skipped
    // (not failed) when no guard was ever captured for this target.
    const capturedGuard =
        typeof targetId === 'number'
            ? getGuardForId(targetId)
            : getGuardForStableId(targetId);
    if (capturedGuard !== undefined && !verifyElementFreshness(el, capturedGuard)) {
        console.warn(`[agent] Element ${targetId} is stale (semantic context changed since extract())`);
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

// #116: hit-test the target's center against whatever actually paints there.
// A cookie banner, sticky header, or modal that covers the target must be
// rejected BEFORE any input is dispatched - dispatching at the element's
// registry node otherwise lands on the overlay and silently does nothing.
//
// The check is deliberately conservative and degrades to "not covered" in
// any environment where it cannot decide:
//   - no elementFromPoint (very old engines / stripped test DOMs),
//   - zero-geometry rects (jsdom has no layout, so every rect is 0x0),
//   - a null hit result (point outside the document's paintable area).
// Flagging an indeterminate case as covered would break every action in
// jsdom-based tests and on geometry-less pages, so ambiguity = proceed.
function isCovered(el: Element): boolean {
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null };
    if (typeof doc.elementFromPoint !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let hit: Element | null;
    try {
        hit = doc.elementFromPoint(x, y);
    } catch {
        return false;
    }
    if (hit === null || hit === undefined) return false;
    // Covered when the topmost node at the center is NOT inside this element.
    // An ancestor hit counts as covered: if an ancestor paints on top at that
    // pixel, this element is behind it (clicking the ancestor is the safe
    // thing anyway, and the planner will target it on re-extract).
    return !el.contains(hit);
}

function rejectIfCovered(el: Element, action: Action) {
    if (isCovered(el)) {
        const id = action.targetId === undefined ? '(focused)' : String(action.targetId);
        throw new Error(`element ${id} is covered by another element - no input dispatched`);
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
    rejectIfCovered(el, action);

    if (el instanceof HTMLElement) {
        el.focus();
    }

    // Real mouse sequence — some sites listen for mousedown, not click.
    // dispatchEvent works on any Element, including SVG.
    // NOTE: no `view` in the init — jsdom (and some embedded webviews) reject
    // a MouseEventInit whose `view` is not their own Window object, and `view`
    // defaults to the event's window in every real engine anyway. Same reason
    // doKey drops `view` from its KeyboardEvent inits.
    const opts = { bubbles: true, cancelable: true };
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

// #122: strict gate on the planner's TYPE payload. The planner is a model;
// its output is untrusted until validated (same discipline as URL
// sanitization for NAVIGATE). An empty value, a non-string, control
// characters, or a runaway length never reaches the DOM - the action fails
// and the planner re-plans instead of typing garbage. Only tab and LF are
// allowed in typed values (textareas need them); CR and every other
// control character is blocked. To clear a field the planner uses KEY
// Backspace, not an empty TYPE.
const MAX_TYPE_VALUE_CHARS = 2000;
// Intentional: this IS the control-character detector (TYPE value gate,
// issue #122) - it must match \u0000-\u0008 / \u000B-\u001F / \u007F.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function validateTypeValue(raw: unknown): string {
    if (typeof raw !== 'string') {
        throw new Error(
            `invalid TYPE value: expected string, got ${raw === undefined ? 'undefined' : typeof raw} - nothing typed`,
        );
    }
    if (raw.trim().length === 0) {
        throw new Error('invalid TYPE value: empty - nothing typed (use KEY Backspace to clear a field)');
    }
    if (raw.length > MAX_TYPE_VALUE_CHARS) {
        throw new Error(`invalid TYPE value: ${raw.length} chars exceeds the ${MAX_TYPE_VALUE_CHARS} cap - nothing typed`);
    }
    if (CONTROL_CHARS.test(raw)) {
        throw new Error('invalid TYPE value: contains control characters - nothing typed');
    }
    return raw;
}

function doType(action: Action) {
    const el = resolve(action.targetId);
    const value = validateTypeValue(action.value);

    scrollIntoView(el);
    // Check before focus: a covered field must not steal focus from the
    // overlay that's actually on top of it.
    rejectIfCovered(el, action);

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
    // else the body (so a key still lands somewhere meaningful). A null /
    // absent targetId means "press on the focused element" - the planner uses
    // that to submit a search box it just typed into. (Bug: null was treated
    // as a resolvable id -> "element null not found" and the Enter never fired.)
    let target: Element | null = null;
    if (action.targetId !== undefined && action.targetId !== null) {
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

    // #114: synthetic (untrusted) key events do NOT trigger native form
    // submission in Chromium - an Enter dispatched via KeyboardEvent makes
    // Wikipedia's search form sit there, so the agent typed the query,
    // "pressed Enter", and the page never navigated (observed live 2026-09-19:
    // steps 5-12 looping on the unsubmitted box). When the key is Enter and
    // the target sits in a form, submit the form the way a real keypress
    // would: requestSubmit() fires the submit event, runs default handlers,
    // and navigates. Fallback for targets without a form (e.g. body): plain
    // key dispatch already ran above, nothing more to do.
    if (name === 'Enter') {
        const form = target instanceof Element ? target.closest('form') : null;
        if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
        }
    }
}

// #119: event-aware post-action settle.
//
// The old executor slept a blanket 120ms after every non-WAIT action. That is
// too slow for plain clicks/scrolls and too short to catch a combobox's
// autocomplete list, which may not exist yet when we re-extract. So:
//   - after TYPE into a combobox, poll (bounded) until a visible
//     [role="option"] appears in the field's aria-controls/aria-owns root;
//   - every other action settles for a short 50ms.
// The combobox poll is capped so a runaway wait can't wedge a run.
//
// Geometry guard: jsdom has no layout, so [role=option] rects read 0x0 and the
// poll can never "see" a suggestion there. That is fine - in jsdom we simply
// fall through the cap and settle, which is the safe behaviour for tests.

// Short settle used for every non-combobox action (was 120ms blanket).
const SETTLE_MS = 50;
// Cap on the combobox autocomplete poll.
const SUGGESTION_CAP_MS = 200;

// True when this element is a field that drives an autocomplete/suggestion
// list: an explicit role="combobox" input, or a field that points at a
// controlled list via aria-controls/aria-owns.
function isComboboxField(el: Element): boolean {
    if (el.getAttribute?.('role') === 'combobox') return true;
    const owner =
        el.getAttribute?.('aria-controls') || el.getAttribute?.('aria-owns');
    return typeof owner === 'string' && owner.trim() !== '';
}

// Find a visible [role=option] under the field's controlled root(s).
// Visible = a non-zero geometry rect (jsdom reads 0x0, so this is false there).
function hasVisibleSuggestion(el: Element): boolean {
    const controls = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '')
        .split(/\s+/).filter(Boolean);
    const roots: ParentNode[] = [document];
    for (const id of controls) {
        const root = document.getElementById(id);
        if (root) roots.push(root);
    }
    for (const root of roots) {
        const options = root.querySelectorAll('[role="option"]');
        for (const opt of Array.from(options)) {
            const r = opt.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
        }
    }
    return false;
}

async function settleFor(action: Action): Promise<void> {
    if (action.type === 'TYPE' && action.targetId !== undefined && action.targetId !== null) {
        const target = action.targetId;
        let el: Element | undefined;
        try {
            el = typeof target === 'number'
                ? getElementById(target)
                : getElementByStableId(target);
        } catch {
            el = undefined;
        }
        if (el && isComboboxField(el)) {
            // Poll until the suggestion list is visible or the cap is hit.
            const deadline = Date.now() + SUGGESTION_CAP_MS;
            while (Date.now() < deadline) {
                if (hasVisibleSuggestion(el)) return;
                await delay(20);
            }
            return;
        }
    }
    await delay(SETTLE_MS);
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

// #101: show the agent-cursor overlay for this action's target. Presentation
// only - every failure path (unknown target, detached element, no DOM) just
// skips the overlay; it must never fail or delay the action itself. KEY
// without a target points at the currently-focused element.
function presentCursor(action: Action): void {
    try {
        const kind: CursorActionKind =
            action.type === 'TYPE' ? 'TYPE'
            : action.type === 'SELECT' ? 'SELECT'
            : action.type === 'KEY' ? 'KEY'
            : 'CLICK';
        let el: Element | undefined;
        if (action.targetId !== undefined) {
            el = resolve(action.targetId);
        } else if (action.type === 'KEY' && typeof document !== 'undefined') {
            el = document.activeElement ?? undefined;
        }
        if (el) showCursor(el, kind);
    } catch {
        /* overlay is optional; the action proceeds either way */
    }
}

export async function execute(action: Action): Promise<ActionResult> {
    const started = performance.now();

    // #101: present the agent-cursor overlay over the target BEFORE the action
    // lands, so the user sees exactly where the agent is about to act. Pure
    // presentation: showCursor never throws (bad rect / detached node just
    // returns false) and never logs element values. NAVIGATE tears it down -
    // the element it pointed at ceases to exist on the new page.
    if (action.type === 'NAVIGATE') {
        hideCursor();
    } else {
        presentCursor(action);
    }

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
        // #119: let the page react before we report success. Event-aware:
        // combobox typing polls for the suggestion list (bounded), everything
        // else gets a short 50ms settle instead of the old blanket 120ms.
        // WAIT already yielded for its full duration, so it settles itself.
        if (action.type !== 'WAIT') {
            await settleFor(action);
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
            covered: isCoveredError(error),
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

// #116: true when the failure is an overlay covering the target (hit-test
// rejected it before any input). Like a stale element, re-acting on the same
// id cannot fix a covered target - the planner must dismiss the overlay and
// re-extract, so the retry loops short-circuit on it.
function isCoveredError(message: string): boolean {
    return message.toLowerCase().includes('covered by another element');
}

// #122: true when the failure is a rejected TYPE value (empty / non-string /
// over-long / control characters). It is deterministic - re-acting the same
// action with the same value will fail identically, so the retry loops must
// not burn their backoff on it; the planner re-plans a correct value instead.
function isInvalidValueError(message: string): boolean {
    return message.toLowerCase().includes('invalid TYPE value');
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
    // #116: a covered target is blocked by an overlay. Re-clicking/typing the
    // same element will keep hitting the same overlay - return immediately so
    // the planner dismisses the overlay and re-extracts.
    if (first.covered) {
        return first;
    }
    // #122: a rejected value is deterministic - re-typing the same junk will
    // fail the same way. Return immediately so the planner re-plans instead of
    // retrying into the same rejection.
    if (isInvalidValueError(first.error ?? '')) {
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

        // #116: a covered target is blocked by an overlay for the same reason
        // a stale one is hopeless - re-acting on the same id keeps hitting the
        // same overlay. Stop and let the planner dismiss it and re-extract.
        if (result.covered) {
            break;
        }

        // #122: a rejected TYPE value is deterministic - re-typing the same
        // value fails the same way. Stop the backoff so the planner can
        // re-plan instead of retrying into the same rejection.
        if (isInvalidValueError(result.error ?? '')) {
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
        covered: results.some((r) => r.covered),
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
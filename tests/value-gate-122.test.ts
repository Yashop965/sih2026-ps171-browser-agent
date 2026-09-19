/**
 * Issue #122 - strict value gate for TYPE actions.
 *
 * The planner is a model and its output is untrusted (same discipline as the
 * URL sanitization for NAVIGATE). A TYPE value must validate as a clean,
 * non-empty, bounded string before it reaches the DOM - commentary, objects,
 * multi-kilobyte junk, or control characters are rejected and the action
 * fails so the planner re-plans instead of typing garbage.
 *
 * The gate lives in doType (the only place a typed value lands), so these
 * tests drive execute() with a real registered input. The value never reaches
 * the DOM on rejection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execute, executeWithRetry } from '../src/lib/actions';
import { extract } from '../src/lib/dom';

const origRect = Element.prototype.getBoundingClientRect;

function stubLayout() {
    Element.prototype.getBoundingClientRect = function () {
        return {
            x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40,
            width: 40, height: 40,
            toJSON: () => ({}),
        } as DOMRect;
    };
}

afterEach(() => {
    Element.prototype.getBoundingClientRect = origRect;
    document.body.innerHTML = '';
});

function inputId(): number {
    document.body.innerHTML = '<input id="f" type="text" name="q" />';
    stubLayout();
    return extract().find((e) => e.label.length > 0)!.id;
}

describe('Issue #122 - TYPE value gate', () => {
    it('accepts a normal string value', async () => {
        const id = inputId();
        const result = await execute({ type: 'TYPE', targetId: id, value: 'hello' });
        expect(result.ok).toBe(true);
        expect((document.getElementById('f') as HTMLInputElement).value).toBe('hello');
    });

    it('rejects a non-string value (object / array / number)', async () => {
        const id = inputId();
        const result = await execute({ type: 'TYPE', targetId: id, value: { junk: true } as unknown as string });
        expect(result.ok).toBe(false);
        expect(result.error ?? '').toMatch(/invalid TYPE value/i);
        expect((document.getElementById('f') as HTMLInputElement).value).toBe('');
    });

    it('rejects an empty / whitespace-only value', async () => {
        const id = inputId();
        const result = await execute({ type: 'TYPE', targetId: id, value: '   ' });
        expect(result.ok).toBe(false);
        expect(result.error ?? '').toMatch(/invalid TYPE value/i);
    });

    it('rejects an over-long value (> 2000 chars)', async () => {
        const id = inputId();
        const result = await execute({ type: 'TYPE', targetId: id, value: 'a'.repeat(2001) });
        expect(result.ok).toBe(false);
        expect(result.error ?? '').toMatch(/exceeds the 2000 cap/i);
    });

    it('accepts a value at exactly the 2000-char cap', async () => {
        const id = inputId();
        const result = await execute({ type: 'TYPE', targetId: id, value: 'a'.repeat(2000) });
        expect(result.ok).toBe(true);
    });

    it('rejects a value containing control characters (but not newline/tab)', async () => {
        const id = inputId();
        // NUL / ESC control chars must be blocked:
        const bad = await execute({ type: 'TYPE', targetId: id, value: 'a\u0000b' });
        expect(bad.ok).toBe(false);
        expect(bad.error ?? '').toMatch(/control characters/i);
        // Newline + tab are legitimate for textareas and are allowed. Use an
        // actual <textarea>: an <input> normalizes \n away per the HTML spec,
        // so only a textarea can prove the value survived the round trip.
        document.body.innerHTML = '<textarea id="ta" name="bio"></textarea>';
        const taId = extract().find((e) => e.label.length > 0)!.id;
        const good = await execute({ type: 'TYPE', targetId: taId, value: 'line1\nline2\ttab' });
        expect(good.ok).toBe(true);
        expect((document.getElementById('ta') as HTMLTextAreaElement).value).toBe('line1\nline2\ttab');
    });

    it('is non-retryable: executeWithRetry returns after one attempt on a rejected value', async () => {
        const id = inputId();
        const result = await executeWithRetry({ type: 'TYPE', targetId: id, value: 'a'.repeat(5000) });
        expect(result.ok).toBe(false);
        expect(result.error ?? '').toMatch(/invalid TYPE value/i);
        // A deterministic rejection must not have triggered the 400ms retry
        // delay / second attempt - it returns the first result as-is.
        expect(result.stale).toBe(false);
    });
});

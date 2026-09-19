/**
 * Issue #118 - semantic freshness guard.
 *
 * resolve() only checked el.isConnected, so a re-render that rewrites the
 * surrounding context while the widget node stays mounted still passed - and
 * we'd act on a target whose meaning just changed. Now:
 *   - extract() captures a MASKED semantic guard per element (tag | role |
 *     masked nearest-scope text),
 *   - resolve() re-reads it just before acting; a mismatch throws the same
 *     "stale" error as a detached node, so the issue #64 stale path handles
 *     it (planner re-extracts, no retry on the dead decision).
 *
 * PII firewall rule (the whole point of #118's design): the guard is the
 * maskLabel() output of the scope text. Raw PII in a form (a PAN printed
 * inside the markup) is masked before it can be stored; the guard is only
 * ever compared locally, never transmitted.
 *
 * TYPE is used to drive resolve(): the guard check happens inside resolve()
 * before any dispatch, and a successful CLICK would trip the pre-existing
 * jsdom `view` MouseEvent gap (fixed separately in the occlusion PR).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execute } from '../src/lib/actions';
import {
    captureElementGuard,
    extract,
    getGuardForId,
    maskLabel,
    verifyElementFreshness,
    type ExtractedElement,
} from '../src/lib/dom';

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

function registerField(): number {
    const els: ExtractedElement[] = extract();
    return els.find((e) => e.label.length > 0)!.id;
}

beforeEach(() => {
    document.body.innerHTML = `
        <form id="f1">
            <span>Section: Profile</span>
            <input id="field" type="text" name="query" />
        </form>
    `;
    stubLayout();
});

afterEach(() => {
    Element.prototype.getBoundingClientRect = origRect;
    document.body.innerHTML = '';
});

describe('Issue #118 - semantic freshness guard', () => {
    it('lets a TYPE through when the semantic scope is unchanged', async () => {
        const id = registerField();
        const result = await execute({ type: 'TYPE', targetId: id, value: 'x' });
        expect(result.ok).toBe(true);
    });

    it('flags STALE when the scope text changed in place (node still connected)', async () => {
        const id = registerField();
        // Simulate a re-render that rewrites the section UNDER the still-
        // mounted input. The node survives (isConnected stays true - the old
        // check would pass); the guard must catch the meaning change.
        const extra = document.createElement('span');
        extra.textContent = 'Re-rendered section: Payment details';
        document.getElementById('f1')!.appendChild(extra);

        const result = await execute({ type: 'TYPE', targetId: id, value: 'x' });
        expect(result.ok).toBe(false);
        expect(result.stale).toBe(true);
        expect(result.error ?? '').toMatch(/stale/i);
    });

    it('stores the MASKED scope text, never raw PII (firewall check)', async () => {
        // Put a PAN into the form markup - the guard must hold the masked
        // form, so a later scope rewrite cannot leak the raw digits anywhere
        // the guard is compared. (ABCDE1234F matches the PAN rule: 5 letters,
        // 4 digits, 1 letter.)
        document.body.innerHTML = `
            <form id="f1">
                <span>PAN: ABCDE1234F</span>
                <input id="field" type="text" name="query" />
            </form>
        `;
        const id = registerField();
        const guard = getGuardForId(id)!;
        expect(guard).toContain('[PAN]');
        expect(guard).not.toContain('ABCDE1234F');
    });

    it('a PII re-render inside the scope does NOT invalidate the decision (mask is the firewall)', async () => {
        // Deliberate: the guard compares MASKED text, and maskLabel collapses
        // any PAN to the constant [PAN] tag. So swapping one PAN for another
        // of the same shape yields identical masked text -> the element stays
        // FRESH. A PII re-render must not invalidate the planner's decision,
        // and the raw digits never enter the comparison (PII firewall).
        document.body.innerHTML = `
            <form id="f1">
                <span>PAN: ABCDE1234F</span>
                <input id="field" type="text" name="query" />
            </form>
        `;
        const id = registerField();
        // "Re-render" that changes the PAN value (new digits, same shape):
        const span = document.querySelector('#f1 span')!;
        span.textContent = 'PAN: ABCDE9999F';
        const result = await execute({ type: 'TYPE', targetId: id, value: 'x' });
        expect(result.ok).toBe(true); // masked text unchanged -> still fresh
        // and the guard never held the raw digits
        const guard = getGuardForId(id)!;
        expect(guard).not.toContain('ABCDE1234F');
        expect(guard).not.toContain('ABCDE9999F');
    });

    it('verifyElementFreshness: self-match and role-change are detected', () => {
        const input = document.createElement('input');
        input.setAttribute('name', 'q');
        document.body.appendChild(input);
        const guard = captureElementGuard(input);
        expect(verifyElementFreshness(input, guard)).toBe(true);
        // tag / role changed -> the target is a different control now
        input.setAttribute('role', 'combobox');
        expect(verifyElementFreshness(input, guard)).toBe(false);
    });
});

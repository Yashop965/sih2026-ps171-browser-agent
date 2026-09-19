/**
 * Issue #120 - cap extract() at 250 elements and surface the omitted count.
 *
 * On a long ISRO form / list-heavy portal page the element table sent to the
 * planner grew unbounded, bloating the prompt and the cost. Now:
 *   - extract() keeps at most EXTRACT_CAP (250) elements in document order,
 *   - the planner is told how many it did NOT see (omitted), carried on
 *     PageContext because that is the channel that already reaches the
 *     planner (the elements themselves are capped).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    extract,
    EXTRACT_CAP,
    getPageContext,
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

afterEach(() => {
    Element.prototype.getBoundingClientRect = origRect;
    document.body.innerHTML = '';
});

function fillBody(n: number) {
    // N distinct interactive controls in document order.
    document.body.innerHTML = Array.from({ length: n }, (_, i) =>
        `<button data-i="${i}">b${i}</button>`
    ).join('');
}

describe('Issue #120 - extract cap + omitted count', () => {
    it('returns everything when the page is under the cap', () => {
        fillBody(50);
        stubLayout();
        const els = extract();
        expect(els.length).toBe(50);
        expect(getPageContext().omitted).toBe(0);
    });

    it('caps the element table at EXTRACT_CAP when the page is over it', () => {
        const n = EXTRACT_CAP + 75;
        fillBody(n);
        stubLayout();
        const els = extract();
        expect(els.length).toBe(EXTRACT_CAP);
        // The cap keeps document order: the first 250 controls, not a random
        // subset.
        expect((els[0] as ExtractedElement).label).toBe('b0');
        expect(els[EXTRACT_CAP - 1]!.label).toBe(`b${EXTRACT_CAP - 1}`);
    });

    it('reports the omitted count on the PageContext channel the planner receives', () => {
        const n = EXTRACT_CAP + 75;
        fillBody(n);
        stubLayout();
        extract();
        // getPageContext() is what background forwards as `context` to the
        // planner; the counter rides on it.
        expect(getPageContext().omitted).toBe(75);
    });

    it('omitted is 0 after re-extracting a smaller page (state resets each call)', () => {
        fillBody(EXTRACT_CAP + 100);
        stubLayout();
        extract();
        expect(getPageContext().omitted).toBe(100);
        // Scroll / re-extract on a smaller page: the counter must not leak.
        fillBody(20);
        extract();
        expect(getPageContext().omitted).toBe(0);
        expect(extract().length).toBe(20);
    });
});

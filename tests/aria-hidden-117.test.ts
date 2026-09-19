/**
 * Issue #117 - exclude controls inside aria-hidden="true" / inert subtrees.
 *
 * extract() used to include visually-present controls that live inside
 * semantically-off-limits subtrees (decorative mirrors, disabled sections,
 * collapsed drawers) - trap targets the planner keeps trying to act on.
 *
 * jsdom has no layout, so extract() (which drops zero-geometry elements in
 * isVisible) needs getBoundingClientRect stubbed to report a visible box.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extract } from '../src/lib/dom';

// Stub the layout so isVisible()'s geometry gate passes; everything else in
// extract() (getComputedStyle, closest, querySelectorAll) is real jsdom.
const origRect = Element.prototype.getBoundingClientRect;

function stubLayout() {
    Element.prototype.getBoundingClientRect = function () {
        return {
            x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20,
            width: 20, height: 20,
            toJSON: () => ({}),
        } as DOMRect;
    };
}

function restoreLayout() {
    Element.prototype.getBoundingClientRect = origRect;
}

describe('Issue #117 - aria-hidden / inert exclusion in extract()', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <button id="normal">Normal</button>
            <div inert><button id="inert">Inert</button></div>
            <div aria-hidden="true"><button id="aria-hidden">Hidden</button></div>
            <div aria-hidden="false"><button id="aria-visible">ARIA Visible</button></div>
            <button id="child-of-hidden"><span aria-hidden="true">decor</span>Real</button>
        `;
        stubLayout();
    });

    afterEach(restoreLayout);

    it('excludes controls inside an [inert] subtree', () => {
        const ids = extract().map((e) => e.label);
        expect(ids).not.toContain('Inert');
    });

    it('excludes controls inside an aria-hidden="true" subtree', () => {
        const ids = extract().map((e) => e.label);
        expect(ids).not.toContain('Hidden');
    });

    it('keeps controls inside an aria-hidden="false" subtree', () => {
        const ids = extract().map((e) => e.label);
        expect(ids).toContain('ARIA Visible');
    });

    it('keeps an element whose CHILD is aria-hidden (only ancestors matter)', () => {
        const ids = extract().map((e) => e.label);
        // The button's label reads its child text, so "decor" (the hidden
        // span) is part of it - the point is the BUTTON itself survived.
        expect(ids).toContain('decorReal');
    });

    it('still includes the plain control', () => {
        const ids = extract().map((e) => e.label);
        expect(ids).toContain('Normal');
    });
});

/**
 * #205 — content-invariant element identity, so a re-render cannot make a
 * planner-chosen id point at a different control.
 *
 * ## The defect
 *
 * `extract()` issued **positional** ids (`nextId++` from 1, in DOM order) and
 * clears + rebuilds the registry on every call. The planner is shown the numeric
 * `targetId` and chooses by position. If the page re-renders or navigates
 * between `fetchPlan` and `executeAction` — an LLM round-trip, seconds — every id
 * after the insertion point shifts, and the chosen id now names a **different,
 * live** element.
 *
 * The existing guards cannot catch this. `isConnected` passes (it is a real
 * element) and the #118 semantic guard passes (the wrong element's own context is
 * unchanged). Both answer "is this element still what it was?", not "is this the
 * element the planner chose?".
 *
 * ## What already existed, and why it was not enough
 *
 * `extract()` also built a content-invariant `stableId` (tag + name/for + role +
 * label), the server could resolve one back to a numeric id, and the executor
 * could look one up. The plumbing was present at both ends. Two problems blocked
 * using it:
 *
 * **1. It was ambiguous.** Measured on 7 controls — two "Add row" buttons, two
 * "Save" buttons, three unlabelled text inputs — the recipe produced only **3
 * distinct ids**:
 *
 *     input|||unnamed   x3     <- all three collapse
 *     button|||Add row  x2
 *     button|||Save     x2
 *
 * `stableIdRegistry.set` is last-write-wins, so two of the three inputs were
 * **unreachable by id**. Promoting `stableId` to the planner's target today would
 * have made the agent blind to most form controls.
 *
 * **2. The docstring claimed a guarantee the code did not provide** — it
 * described an "ordinal among same-kind siblings" that was never implemented,
 * which is what let this read as intentional for so long.
 *
 * ## The fix
 *
 * Compute the ordinal, scoped to elements sharing the same **base** id — not all
 * same-tag siblings. That distinction is load-bearing: a same-kind-sibling
 * ordinal would renumber a control when an unrelated control of that kind is
 * inserted earlier, reintroducing the positional instability this removes.
 *
 * The ordinal is appended **only when needed**, so a unique id keeps its exact
 * previous value and only genuinely-colliding ids gain a suffix. That keeps
 * existing handoffs and history that reference a stableId valid.
 *
 * ## Deliberately NOT changed
 *
 * **The planner still emits numeric ids.** Making it emit `stableId` changes the
 * prompt and therefore model behaviour on every task. The collision work above
 * shows it cannot be done safely until the identity is genuinely unique — which
 * this PR delivers. Promoting the id is a separate, separately-reviewed change.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extract, getElementByStableId } from '../src/lib/dom';

/** jsdom reports zero-size rects, which `isVisible` rejects. Stub it. */
function makeVisible(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 10,
    right: 10,
    width: 10,
    height: 10,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  makeVisible();
});

const REPEATED = `
  <form>
    <button type="button">Add row</button>
    <button type="button">Add row</button>
    <input type="text" />
    <input type="text" />
    <input type="text" />
    <button type="button">Save</button>
    <button type="button">Save</button>
  </form>`;

describe('#205 every control gets a reachable stable id', () => {
  beforeEach(() => {
    document.body.innerHTML = REPEATED;
  });

  it('7 controls produce 7 distinct stable ids', () => {
    const els = extract();
    const ids = els.map((e) => e.stableId);
    expect(els.length).toBe(7);
    // The core guarantee. Before #205 this was 3.
    expect(new Set(ids).size).toBe(7);
  });

  it('every stable id resolves back to a real, distinct element', () => {
    // The failure that made the bug dangerous: last-write-wins meant shadowed
    // controls were unreachable. Uniqueness of the id is necessary but not
    // sufficient - each must actually resolve.
    const els = extract();
    const resolved = els.map((e) => getElementByStableId(e.stableId));
    expect(resolved.every(Boolean)).toBe(true);
    // And they must be the SAME elements, not 7 lookups all hitting one node.
    expect(new Set(resolved).size).toBe(7);
  });

  it('resolves to the element the id was issued for, not a lookalike', () => {
    const els = extract();
    const nodes = Array.from(document.querySelectorAll('button,input'));
    for (const [i, e] of els.entries()) {
      expect(getElementByStableId(e.stableId)).toBe(nodes[i]);
    }
  });
});

describe('#205 the ordinal is scoped to collisions, not to same-tag siblings', () => {
  it('a UNIQUE control keeps its exact pre-#205 id', () => {
    // No suffix on an unambiguous id, so existing handoffs and history that
    // reference a stableId stay valid.
    document.body.innerHTML = '<form><input name="email" type="text" /></form>';
    const [el] = extract();
    // role and label are derived (getRole/getLabel), not empty - the point is
    // that the whole id carries NO ordinal suffix when it is already unique.
    expect(el.stableId).toBe('input|email|textbox|text_field');
    expect(el.stableId).not.toMatch(/#/);
  });

  it('the first of a colliding group keeps the bare id', () => {
    document.body.innerHTML = '<form><input type="text" /><input type="text" /></form>';
    const els = extract();
    const base = els[0].stableId.replace(/#\d+$/, '');
    expect(els[0].stableId).toBe(base);
    expect(els[1].stableId).toBe(`${base}#1`);
  });

  it('adding an UNRELATED control does not renumber an existing one', () => {
    // The property that distinguishes this from a same-kind-sibling ordinal.
    document.body.innerHTML = '<form><input name="a" type="text" /></form>';
    const before = extract().map((e) => e.stableId);

    document.body.insertAdjacentHTML('afterbegin', '<select name="s"><option>1</option></select>');
    const after = extract().map((e) => e.stableId);

    expect(after).toContain(before[0]);
  });

  it('adding a NEW labelled input leaves the other labelled inputs untouched', () => {
    // The positional-instability case. With a same-kind-sibling ordinal, adding
    // an input at the top would shift every later input; with a base-scoped
    // ordinal each labelled input is in its own unique group and is unaffected.
    document.body.innerHTML = `
      <form>
        <input name="email" type="text" />
        <input name="phone" type="text" />
      </form>`;
    extract();
    document.body
      .querySelector('form')!
      .insertAdjacentHTML('afterbegin', '<input name="zip" type="text" />');
    const after = extract().map((e) => e.stableId);
    expect(after).toContain('input|email|textbox|text_field');
    expect(after).toContain('input|phone|textbox|text_field');
  });
});

describe('#205 the docstring no longer claims a guarantee the code lacks', () => {
  it('documents the base-scoped ordinal it actually computes', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/lib/dom.ts', 'utf-8');
    // The stale claim is gone...
    expect(src).not.toMatch(/its ordinal among same-kind siblings/);
    // ...and the real scoping is stated, because the next reader needs to know
    // this was deliberate and not an oversight.
    expect(src).toMatch(/BASE id/);
  });
});

describe('#205 the existing guards and the planner contract are untouched', () => {
  it('isConnected and the #118 guard still exist', async () => {
    const { readFileSync } = await import('node:fs');
    const actions = readFileSync('src/lib/actions.ts', 'utf-8');
    expect(actions).toMatch(/isConnected/);
    expect(actions).toMatch(/verifyElementFreshness/);
  });

  it('numeric ids are still issued 1..N - the planner contract is unchanged', () => {
    document.body.innerHTML = REPEATED;
    const els = extract();
    expect(els.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

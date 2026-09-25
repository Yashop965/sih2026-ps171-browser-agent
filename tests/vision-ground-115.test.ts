import { describe, it, expect } from 'vitest';
import {
  scaleBoxToCss,
  resolveGroundNode,
  bridgeGroundBoxes,
  groundQueryForContext,
  type GroundBox,
} from '../src/lib/visionGround';

/**
 * #115: the pure (DOM-injected) half of the VLM grounding fallback. The
 * screenshot-pixel -> CSS-viewport scaling, the elementFromPoint bridge to a
 * meaningful DOM node, the dedupe against already-extracted DOM, and the
 * grounding-query builder. A fake document lets us test the bridge logic
 * without a live browser / live model.
 */

/** A minimal fake Element good enough for the resolver's tag/role/parent walk. */
function fakeEl(opts: {
  tag?: string;
  role?: string;
  parent?: any;
  attrs?: Record<string, string>;
} = {}): any {
  const el: any = {
    tagName: (opts.tag ?? 'div').toUpperCase(),
    parentElement: opts.parent ?? null,
    _attrs: opts.attrs ?? {},
    getAttribute(n: string) {
      return this._attrs[n] ?? null;
    },
    hasAttribute(n: string) {
      return n in this._attrs;
    },
  };
  if (opts.role) el._attrs.role = opts.role;
  return el;
}

function fakeDoc(map: Array<[string, any]>): {
  document: { elementFromPoint: (x: number, y: number) => Element | null };
  hits: string[];
} {
  const byKey: Record<string, any> = {};
  for (const [k, v] of map) byKey[k] = v;
  const hits: string[] = [];
  const document = {
    elementFromPoint: (x: number, y: number): Element | null => {
      // Key boxes by their CSS center (x.toFixed(1)+y) so tests can target a
      // specific hit.
      const key = `${x.toFixed(1)}:${y.toFixed(1)}`;
      hits.push(key);
      return byKey[key] ?? null;
    },
  };
  return { document, hits };
}

describe('#115 scaleBoxToCss — screenshot-pixel -> CSS-viewport scaling', () => {
  it('divides by devicePixelRatio (dpr=2 halves a 2x capture)', () => {
    const box: GroundBox = { x: 100, y: 200, width: 50, height: 40 };
    const r = scaleBoxToCss(box, 2);
    // center: (100+25, 200+20) = (125,220) in px -> (62.5,110) in CSS
    expect(r.cx).toBe(62.5);
    expect(r.cy).toBe(110);
    expect(r.rect).toEqual({ x: 50, y: 100, width: 25, height: 20 });
  });

  it('dpr=0/undefined is treated as 1 (no scaling)', () => {
    const r = scaleBoxToCss({ x: 10, y: 10, width: 20, height: 20 }, 0);
    expect(r.cx).toBe(20);
    expect(r.cy).toBe(20);
  });
});

describe('#115 resolveGroundNode — bridge to a meaningful node', () => {
  it('returns the hit node when it is itself meaningful (a button)', () => {
    const btn = fakeEl({ tag: 'button' });
    const { document } = fakeDoc([['10.0:10.0', btn]]);
    expect(resolveGroundNode(document, 10, 10)).toBe(btn);
  });

  it('filters out the html/body root (nothing to act on)', () => {
    const body = fakeEl({ tag: 'body' });
    const { document } = fakeDoc([['5.0:5.0', body]]);
    expect(resolveGroundNode(document, 5, 5)).toBeNull();
  });

  it('walks up to a meaningful ancestor (decorative span inside a link)', () => {
    const link = fakeEl({ tag: 'a', attrs: { href: '#' } });
    const span = fakeEl({ tag: 'span', parent: link }); // not meaningful, parent is
    const { document } = fakeDoc([['3.0:3.0', span]]);
    expect(resolveGroundNode(document, 3, 3)).toBe(link);
  });

  it('keeps a role-marked div (a styled widget)', () => {
    const div = fakeEl({ tag: 'div', role: 'button' });
    const { document } = fakeDoc([['7.0:7.0', div]]);
    expect(resolveGroundNode(document, 7, 7)).toBe(div);
  });

  it('falls back to the raw hit when no ancestor is meaningful', () => {
    const p = fakeEl({ tag: 'p' }); // structural, no role
    const { document } = fakeDoc([['9.0:9.0', p]]);
    expect(resolveGroundNode(document, 9, 9)).toBe(p);
  });
});

describe('#115 bridgeGroundBoxes — dedupe + order', () => {
  it('resolves each box, dedupes against existing DOM nodes, keeps order', () => {
    const a = fakeEl({ tag: 'button' });
    const b = fakeEl({ tag: 'input' });
    const existing = [a] as Element[]; // DOM already found node A
    // dpr=1: a box's CSS center = (x + w/2, y + h/2).
    //   box A (center 1,1) -> fake-doc key '1.0:1.0' -> node a (existing) -> skipped
    //   box B (center 2,2) -> fake-doc key '2.0:2.0' -> node b (new)       -> bridged
    const { document } = fakeDoc([
      ['1.0:1.0', a],
      ['2.0:2.0', b],
    ]);
    const boxes: GroundBox[] = [
      { x: 0, y: 0, width: 2, height: 2, label: 'a-label' }, // center (1,1)
      { x: 1, y: 1, width: 2, height: 2, label: 'b-label' }, // center (2,2)
    ];
    const out = bridgeGroundBoxes(document, boxes, 1, existing);
    // Only B is new; A is filtered (already in the DOM set).
    expect(out.length).toBe(1);
    expect(out[0].el).toBe(b);
    expect(out[0].label).toBe('b-label');
  });

  it('skips boxes whose hit resolves to null (body/root)', () => {
    const body = fakeEl({ tag: 'body' });
    const { document } = fakeDoc([['4.0:4.0', body]]);
    const boxes: GroundBox[] = [{ x: 4, y: 4, width: 1, height: 1, label: 'x' }];
    const out = bridgeGroundBoxes(document, boxes, 1, []);
    expect(out).toHaveLength(0);
  });
});

describe('#115 groundQueryForContext — task-specialized widget list', () => {
  it('always returns a "find:" phrase list', () => {
    const q = groundQueryForContext();
    expect(q.startsWith('find:')).toBe(true);
    expect(q).toContain('button');
  });

  it('pulls a task-named widget forward', () => {
    const q = groundQueryForContext('fill the search box and submit');
    // "search box" and "submit button" are in the base list -> present.
    expect(q).toContain('search box');
    expect(q).toContain('submit button');
  });
});

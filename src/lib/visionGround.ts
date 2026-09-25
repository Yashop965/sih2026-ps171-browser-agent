/**
 * #115: VLM grounding fallback - pure (DOM-injected) helpers.
 *
 * When a page's DOM extraction is near-empty (canvas UIs, heavy JS widgets,
 * shadow-DOM, 0-2 interactive elements), the on-device Florence-2 *phrase
 * grounding* task (run in the offscreen module worker, #142) returns boxes in
 * screenshot-pixel coords + labels. These helpers turn those boxes back into
 * actionable DOM nodes the executor can actually drive:
 *
 *   box (screenshot px) -> CSS viewport coords (divide by devicePixelRatio)
 *   -> document.elementFromPoint(cx, cy) -> nearest meaningful node
 *   -> registered into the dom.ts registry (so targetId resolves).
 *
 * PII boundary (the #100 rule, held through the fallback): only box
 * coordinates + OCR-ish label strings reach the content script; the pixels
 * themselves never leave the offscreen worker. Labels are masked on the way
 * out exactly like DOM labels are (maskLabel is applied by the caller).
 *
 * Everything here takes `document`/`boxes`/`dpr` as parameters so it is
 * unit-testable with a fake document (jsdom) - no live browser required.
 */

/** A Florence-2 grounding box, screenshot-pixel coordinates. */
export interface GroundBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

/** The set of tags/roles worth grounding to. */
const MEANINGFUL_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'option',
  'img',
]);
const MEANINGFUL_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'textbox',
  'combobox',
  'switch',
  'img',
]);

/**
 * Scale a screenshot-pixel box to CSS-viewport coords using the page's
 * devicePixelRatio. A captureVisibleTab screenshot is the visible viewport
 * at dpr scale, so one CSS px = dpr screenshot px. Returns the box's CSS
 * center (what elementFromPoint wants) + CSS rect.
 */
export function scaleBoxToCss(box: GroundBox, dpr: number): { cx: number; cy: number; rect: GroundBox } {
  const s = dpr > 0 ? dpr : 1;
  return {
    cx: (box.x + box.width / 2) / s,
    cy: (box.y + box.height / 2) / s,
    rect: {
      x: box.x / s,
      y: box.y / s,
      width: box.width / s,
      height: box.height / s,
    },
  };
}

function isMeaningful(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (MEANINGFUL_TAGS.has(tag)) return true;
  const role = String(el.getAttribute?.('role') ?? '').toLowerCase();
  if (role && MEANINGFUL_ROLES.has(role)) return true;
  if (el.hasAttribute?.('tabindex') || el.hasAttribute?.('contenteditable')) return true;
  if (tag === 'div' || tag === 'span' || tag === 'li' || tag === 'ul') {
    // A widget is often a styled div/span with a click handler - keep it if it
    // carries a role or is a list item (menu rows). Plain structural divs
    // are filtered out.
    if (role || tag === 'li') return true;
    return false;
  }
  // Unknown tag: keep (a canvas control may be a custom element).
  return true;
}

/**
 * Resolve the node under a CSS point to the nearest *meaningful* one.
 * elementFromPoint can hit a deep text node's container or a decorative
 * wrapper; walk up at most 3 levels to the first meaningful ancestor, else
 * use the hit node itself (still actionable). Returns null when the hit is
 * the body/html root (nothing to act on).
 */
export function resolveGroundNode(
  document: { elementFromPoint: (x: number, y: number) => Element | null },
  cx: number,
  cy: number,
): Element | null {
  let el = document.elementFromPoint(cx, cy) as Element | null;
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return null;
  if (isMeaningful(el)) return el;
  let ancestor = el.parentElement;
  for (let i = 0; i < 3 && ancestor; i++) {
    if (isMeaningful(ancestor)) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return el; // fall back to the raw hit (actionable even if unlabelled)
}

/**
 * Bridge a batch of grounding boxes to DOM nodes. For each box: scale to CSS,
 * hit-test, resolve to a meaningful node, and dedupe against `existingNodes`
 * (avoids double-listing a control DOM extraction already found) and the
 * null/unclickable ones. Returns the successfully-bridged nodes in input
 * order; the CALLER registers each `el` (into dom.ts's registry) and builds
 * the element record - kept out of here so this stays pure and testable.
 */
export interface BridgedNode {
  el: Element;
  rect: GroundBox;
  label: string;
}

export function bridgeGroundBoxes(
  document: { elementFromPoint: (x: number, y: number) => Element | null },
  boxes: GroundBox[],
  dpr: number,
  existingNodes: Iterable<Element>,
): BridgedNode[] {
  const seen = new Set<Element | null>(Array.from(existingNodes));
  const out: BridgedNode[] = [];
  for (const box of boxes) {
    const { cx, cy, rect } = scaleBoxToCss(box, dpr);
    if (cx < 0 || cy < 0) continue;
    const node = resolveGroundNode(document, cx, cy);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    out.push({ el: node, rect, label: box.label ?? '' });
  }
  return out;
}

/**
 * Build a Florence-2 phrase-grounding query. A concrete list of UI-widget
 * phrases beats a blank "find everything": it steers the model toward
 * controls an agent would act on. Caller supplies page/task context to
 * specialize it; a sensible default covers common form/search surfaces.
 */
export function groundQueryForContext(task?: string): string {
  const base = 'search box, input field, text field, button, submit button, link, tab, menu, select dropdown, checkbox, radio button';
  const hint = task ? task.toLowerCase() : '';
  // Pull task-relevant widgets to the front when they are named.
  const extra = [...base.split(', ')]
    .filter((p) => hint.includes(p.split(' ')[0]))
    .slice(0, 3)
    .join(', ');
  return `find: ${[...(extra ? [extra] : []), base].join(', ')}`.replace(/,\s*,/g, ',');
}

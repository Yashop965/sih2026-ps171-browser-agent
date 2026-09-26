// src/lib/dom.ts
// DOM extraction engine — finds every interactive element on the page
// and returns clean metadata. Never reads element values (that would be PII).

export interface ExtractedElement {
  id: number;
  // Stable identifier based on position and label - doesn't change when DOM re-renders
  stableId: string;
  tag: string;
  type: string | null;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  interactive: boolean;
}

const SELECTORS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="tab"]',
  '[onclick]',
  '[contenteditable="true"]',
  // Note: labels are intentionally excluded - they're not interactive form controls
].join(',');

// Map of id -> real DOM node. The executor (#9) uses this to act on elements.
// Rebuilt on every extract() call.
const registry = new Map<number, Element>();
// Map of stableId -> real DOM node for persistent element tracking
const stableIdRegistry = new Map<string, Element>();
// #118: masked semantic guards, captured by extract() and re-checked by the
// executor in actions.ts before acting. id / stableId -> masked scope text.
const guardRegistry = new Map<number, string>();
const stableGuardRegistry = new Map<string, string>();

export function getElementById(id: number): Element | undefined {
  return registry.get(id);
}

export function getElementByStableId(stableId: string): Element | undefined {
  return stableIdRegistry.get(stableId);
}

// #118: the masked guard captured at extract() time for a target. Returns a
// sentinel when the id was never registered (e.g. executor ran before the
// first extract) - in that case the freshness check is skipped, not failed.
export function getGuardForId(id: number): string | undefined {
  return guardRegistry.get(id);
}

export function getGuardForStableId(stableId: string): string | undefined {
  return stableGuardRegistry.get(stableId);
}

// #115: VLM grounding fallback - element ids reserved by the last extract()
// run. Grounded (vision-bridged) elements continue the numbering so the
// executor's targetId registry stays collision-free across a grounding pass.
let nextGroundedId = 1;

/**
 * #115: register a vision-bridged DOM node (found via
 * document.elementFromPoint on a Florence-2 grounding box) so the executor
 * can act on it by targetId / stableId - the PII-safe fallback for near-empty
 * DOM pages (canvas UIs, shadow-DOM widgets, 0-2 element pages).
 *
 * Returns an ExtractedElement-shaped record (id + geometry + masked label) to
 * append to the page snapshot. The label is what the vision model reported,
 * masked through clean() exactly like a DOM label would be.
 */
export function registerGroundedElement(
  el: Element,
  visionLabel: string
): ExtractedElement | undefined {
  const rect = el.getBoundingClientRect();
  const id = nextGroundedId++;
  const tag = el.tagName.toLowerCase();
  const label = clean(visionLabel || tag || 'grounded control');
  const stableId = `grounded|${tag}|${label.replace(/\s+/g, '_').slice(0, 30)}|${id}`;
  registry.set(id, el);
  stableIdRegistry.set(stableId, el);
  const guard = captureElementGuard(el, new Map());
  guardRegistry.set(id, guard);
  stableGuardRegistry.set(stableId, guard);
  return {
    id,
    stableId,
    tag,
    type: el.getAttribute('type'),
    role: getRole(el),
    label,
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    interactive: !isDisabled(el),
  };
}

function isVisible(el: Element, rect: DOMRect): boolean {
  if (rect.width < 2 || rect.height < 2) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) < 0.05) return false;

  // #117: visually-present controls inside aria-hidden="true" or inert
  // subtrees are semantically off-limits (decorative mirrors, disabled
  // sections, hidden drawers). They still pass the display/opacity checks
  // above and become trap targets, so exclude them. An unknown attribute
  // in the selector simply matches nothing on browsers without `inert`
  // support (Firefox < 112), so this degrades to a no-op there.
  try {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
  } catch {
    // closest() can only throw in a broken DOM state; never block
    // extraction on that.
  }

  // Fully outside the viewport
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;

  return true;
}

// --- Label sanitisation -----------------------------------------------------
//
// We never read element.value, so what the user typed never leaves. But a page
// can print PII into its own markup — a portal showing "Aadhaar: 2345 6789
// 0123" inside a link, or a confirmation screen echoing a card number. That
// text is textContent, which labels do read, so it gets masked on the way out.
//
// This runs on every label without exception. There is no "is this element
// sensitive" branch: a rule that applies to everything cannot be bypassed by
// misclassifying one element.

const LABEL_PII: Array<{ re: RegExp; tag: string }> = [
  // Order matters. Longer numeric patterns run first, otherwise a shorter
  // rule consumes part of a longer number and leaves the tail exposed —
  // the Aadhaar rule would eat the first 12 digits of a 16-digit card and
  // leave "1111" in the clear.

  // Card numbers: 13–19 digits, optionally spaced or hyphenated
  { re: /\b\d(?:[\s-]?\d){12,18}\b/g, tag: '[CARD]' },
  // Aadhaar: 12 digits, optionally grouped in fours
  { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, tag: '[AADHAAR]' },
  // PAN: five letters, four digits, one letter
  { re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, tag: '[PAN]' },
  // IFSC: four letters, a zero, six alphanumerics
  { re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, tag: '[IFSC]' },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, tag: '[EMAIL]' },
  // Indian mobile numbers, with or without country code
  { re: /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g, tag: '[PHONE]' },
];

function maskLabel(text: string): string {
  let out = text;
  for (const { re, tag } of LABEL_PII) {
    re.lastIndex = 0; // these are module-level and /g, so reset before reuse
    out = out.replace(re, tag);
  }
  return out;
}

export { maskLabel };

/** Every label leaves through here. Trim, mask, cap. */
function clean(text: string): string {
  return maskLabel(text.trim()).slice(0, 80);
}

// Work out what to call this element, in order of trustworthiness.
// Never falls back to element.value — that could be the user's Aadhaar number.
function getLabel(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);

  // aria-labelledby may list several ids separated by whitespace; the label
  // is the concatenation of all of them, in order.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((refId) => document.getElementById(refId)?.textContent?.trim())
      .filter(Boolean);

    if (parts.length) return clean(parts.join(' '));
  }

  if (el.id) {
    // CSS.escape is absent in some DOM implementations (notably jsdom);
    // fall back to the raw id so a label reference still resolves there.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
    const forLabel = document.querySelector(`label[for="${escaped}"]`);
    if (forLabel?.textContent) return clean(forLabel.textContent);
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel?.textContent) return clean(wrappingLabel.textContent);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return clean(placeholder);

  const title = el.getAttribute('title');
  if (title) return clean(title);

  const alt = el.getAttribute('alt');
  if (alt) return clean(alt);

  // Buttons and links usually carry their own text
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
    const text = el.textContent?.trim();
    if (text) return clean(text);
  }

  if (el instanceof HTMLInputElement) {
    const inputType = el.type;
    if (inputType === 'submit' || inputType === 'button') {
      // Safe here: submit button labels are static UI text, not user data.
      // Masked anyway — a page is free to put anything in that attribute.
      const val = el.value;
      if (val) return clean(val);
    }
    return `${inputType} field`;
  }

  return tag;
}

function getRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button') return 'button';
    return 'textbox';
  }
  return 'generic';
}

function isDisabled(el: Element): boolean {
  if ('disabled' in el && (el as HTMLInputElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return false;
}

// #118: semantic freshness guard. The issue: resolve() only checks
// el.isConnected, so a React/Vue re-render that rewrites a form section in
// place (the node survives, its context no longer is what the planner saw)
// still passes.
//
// The guard is the MASKED text of the element's nearest SEMANTIC scope
// (form / dialog / article / list item / table row), captured when the
// element is registered (captureElementGuard) and re-read just before an
// action executes (verifyElementFreshness); a mismatch means the context
// changed and the decision is stale - the planner re-extracts.
//
// Deliberate limits:
//  - Only semantic scopes are guarded. A top-level control with no form /
//    dialog / row ancestor gets a scope-less guard: NOT the page. Falling
//    back to the parent element would guard the whole document for a
//    top-level control, and that includes the agent's own UI (the cursor
//    overlay appends to <body> and sets label text mid-action) - every
//    re-read would then "detect" the agent's own overlay as a page change.
//  - PII firewall rule: only maskLabel() output ever exists in these
//    guards. Raw scope text is masked in place; the masked string is what
//    is stored and compared, and it is never returned, logged, or sent.

const GUARD_SCOPE_SELECTOR = 'form,dialog,[role="dialog"],article,li,tr,[role="row"]';
const GUARD_TEXT_CAP = 3000;

function guardScope(el: Element): Element | null {
  try {
    return el.closest(GUARD_SCOPE_SELECTOR);
  } catch {
    return null;
  }
}

// Reads only the nearest scope's text (a few hundred chars), not the whole
// document - keeps the 10ms extract budget.
function scopeInner(scope: Element | null): string {
  if (!scope) return '';
  let text: string;
  try {
    // innerText is typed on HTMLElement only; jsdom may not implement it
    // at all (undefined) - fall back to textContent, same semantics for
    // our purposes (rendered text of the scope).
    const inner = (scope as HTMLElement).innerText;
    text = (typeof inner === 'string' && inner ? inner : (scope.textContent ?? '')).trim();
  } catch {
    return '';
  }
  return text.slice(0, GUARD_TEXT_CAP);
}

export function captureElementGuard(el: Element, scopeCache?: Map<Element, string>): string {
  const scope = guardScope(el);
  // Read the scope the SAME way verifyElementFreshness does (scopeInner),
  // and when a cache is supplied (extract() walk) mask the shared scope
  // text once per scope element instead of per control. Scope-less
  // elements get an empty scope text: their guard is still tag|role, so a
  // role re-write on a top-level control is detected without ever
  // spanning the whole page.
  let masked: string;
  if (scope && scopeCache?.has(scope)) {
    masked = scopeCache.get(scope)!;
  } else {
    masked = maskLabel(scopeInner(scope));
    if (scope && scopeCache) scopeCache.set(scope, masked);
  }
  return `${el.tagName}|${el.getAttribute?.('role') ?? ''}|${masked}`;
}

// Re-reads the guard for el and compares against the value captured at
// registration. Returns true when the element and its semantic context are
// unchanged (fresh). Only called for CLICK/SELECT/KEY targets in actions.ts.
export function verifyElementFreshness(el: Element, capturedGuard: string): boolean {
  const scope = guardScope(el);
  // No semantic scope: still compare tag|role (scope text part is empty on
  // both sides, so the comparison stays symmetric with capture).
  const current = `${el.tagName}|${el.getAttribute?.('role') ?? ''}|${
    scope ? maskLabel(scopeInner(scope)) : ''
  }`;
  return current === capturedGuard;
}

// #120: hard cap on the element table the planner receives.
export const EXTRACT_CAP = 250;
// How many matching controls were on the page but cut off by EXTRACT_CAP in
// the last extract() call. 0 until extract() has run (and while the page has
// fewer than the cap).
let lastOmitted = 0;
export function getOmittedCount(): number {
  return lastOmitted;
}

export function extract(): ExtractedElement[] {
  const started = performance.now();
  registry.clear();
  stableIdRegistry.clear();
  guardRegistry.clear();
  stableGuardRegistry.clear();

  const allNodes = Array.from(document.querySelectorAll(SELECTORS));
  // #120: cap the element table so a long ISRO form / list-heavy portal
  // page can't bloat the planner prompt. Order is document order (the
  // querySelectorAll walk), so the cap keeps the top-of-page controls and
  // the planner is told how many it didn't see (omittedCount) so it can
  // pair that with moreContentBelow and scroll.
  const nodes = allNodes.length > EXTRACT_CAP ? allNodes.slice(0, EXTRACT_CAP) : allNodes;
  lastOmitted = allNodes.length - nodes.length;

  const results: ExtractedElement[] = [];
  let nextId = 1;
  // Masked scope text is shared per scope element: dozens of controls in
  // one form read the same text, so read+mask it once per scope.
  const scopeCache = new Map<Element, string>();

  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;

    const id = nextId++;
    const label = getLabel(el);
    // Content-invariant stable ID (issue #62). Previously this was
    // `${label}_${rect.left}_${rect.top}` — screen coordinates — so the
    // same element got a *different* stableId after any scroll. That
    // broke the "already filled" tracking across scroll/re-extract, which
    // is exactly what a scroll-to-reveal form walk needs. Now the id is
    // built from what the element *is* (tag + name/for + role + label +
    // its ordinal among same-kind siblings), never where it is on screen.
    const nameAttr = el.getAttribute?.('name') || '';
    const forAttr = el.getAttribute?.('for') || '';
    const kind = el.tagName.toLowerCase();
    const stableId = [
      kind,
      nameAttr || forAttr,
      getRole(el),
      label.replace(/\s+/g, '_').slice(0, 30) || 'unnamed',
    ].join('|');

    registry.set(id, el);
    stableIdRegistry.set(stableId, el);
    // #118: capture the semantic guard for the executor's freshness check.
    const guard = captureElementGuard(el, scopeCache);
    guardRegistry.set(id, guard);
    stableGuardRegistry.set(stableId, guard);

    results.push({
      id,
      stableId,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      role: getRole(el),
      label,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      interactive: !isDisabled(el),
    });
  }

  const elapsed = performance.now() - started;
  if (elapsed > 10) {
    console.warn(`[dom] extraction took ${elapsed.toFixed(1)}ms (budget: 10ms)`);
  }

  // #115: grounded (vision-bridged) elements continue the id sequence from
  // the last extract() run so targetIds never collide across a grounding pass.
  nextGroundedId = nextId;

  return results;
}

export interface PageContext {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewport: { width: number; height: number };
  // True when the document has content below the current viewport. This is
  // the single signal the planner needs to decide "scroll to reveal more
  // fields". Without it the model only ever sees visible elements and has no
  // idea the form continues (issue #59).
  moreContentBelow: boolean;
  // #120: how many matching interactive controls on the page were cut off
  // by extract()'s 250-element cap, so they are NOT in the element table.
  // 0 = the table is complete. When > 0 the planner should pair this with
  // moreContentBelow and scroll / re-extract instead of assuming the table
  // is the whole page. Carried on PageContext because that is the channel
  // that already reaches the planner (elements are capped; this is the
  // counter that says how much was left behind).
  omitted: number;
}

/**
 * The page URL as it may safely be transmitted: origin + path, with the
 * query string and fragment removed.
 *
 * Issue #170. There were two implementations of "the URL we send", and only
 * one of them sanitised. `captureDOM()` built a URL with `search = ''` and sent
 * that, while `getPageContext()` - carried on the same snapshot as
 * `context` - set `url: location.href` raw. The two sat on the same outbound
 * payload, so the strip the snapshot clearly intended was undone one field
 * away. Query strings are where PII actually lives (`?email=`,
 * `?aadhaar=`, `?token=`), and the fragment is never sent to a server but is
 * routinely used client-side to hold exactly that kind of value.
 *
 * One implementation, both call sites. If this is ever widened, it must widen
 * for both.
 *
 * Degrades rather than throws: a URL the platform refuses to parse (or a
 * missing base) yields an empty string, which the planner reads as "unknown
 * page" instead of the whole extract failing.
 */
export function sanitizedPageUrl(href: string = location.href): string {
  try {
    const u = new URL(href);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

export function getPageContext(): PageContext {
  // 4px epsilon so a page scrolled flush to the bottom doesn't report
  // "more below" and cause an endless scroll.
  const bottom = Math.round(window.scrollY + window.innerHeight);
  const height = Math.round(document.body.scrollHeight);
  return {
    url: sanitizedPageUrl(),
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollHeight: height,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    moreContentBelow: bottom < height - 4,
    omitted: getOmittedCount(),
  };
}

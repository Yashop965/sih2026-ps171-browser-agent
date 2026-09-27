/**
 * Registry of the extension's own overlay roots.
 *
 * Issue #160: `isCovered()` in `actions.ts` is a fail-closed occlusion guard -
 * it hit-tests an element's centre and refuses the action if some other node is
 * on top. That is correct, and it is deliberately conservative (see the
 * function's own docstring: an indeterminate hit means "proceed").
 *
 * The gap is that it has no way to ask "is the thing on top OURS?".
 *
 * ## Nothing is broken today
 *
 * Verified, not assumed: both overlays the extension currently injects set
 * `pointer-events: none` on their host and every child.
 *
 *   agentCursor  `__agent-cursor`   host + .ac-halo/.ac-aura/.ac-arrow/...
 *   highlight    `__agent-highlight` (content.ts)
 *
 * A `pointer-events: none` subtree is skipped by `elementFromPoint`, so
 * neither can make a real target look covered. `#160` was filed *before* the
 * planned floating nudge/stop control exists, precisely so the guard is ready
 * for it.
 *
 * ## Why this is a registry and not a hardcoded list
 *
 * A nudge control is interactive **by definition** - it has to be clickable,
 * so it will be `pointer-events: auto`, so it *will* occlude. When that
 * control is visible over a form field, the guard is right that something is
 * on top and wrong about what: the user sees a working form and an agent that
 * mysteriously will not fill it, with no signal that the cause is our own UI.
 *
 * So the answer is not to loosen the guard - that check is worth more than the
 * convenience. It is to let the guard recognise its own UI.
 *
 * ## Registering a host
 *
 * `registerOverlayRoot` exists so a new interactive overlay has ONE obvious
 * thing to call. Registration is by element or by id, and is idempotent. The
 * helper is deliberately tiny; the interesting part is the *shape* of the
 * contract it establishes for future overlays.
 */

/**
 * Ids of overlay hosts the extension owns. The value is the element id, which
 * is what the extension's own code already uses (`getElementById`).
 */
const overlayRootIds = new Set<string>();

/** Live references, for the common case of the hit being the host itself. */
const overlayRootElements = new WeakSet<Element>();

/**
 * Mark an element (or an element id) as an extension-owned overlay root.
 *
 * Idempotent. A shadow host is the right thing to register - the hit may be a
 * node inside its shadow tree, and `isOwnOverlayNode` walks up to the host.
 */
export function registerOverlayRoot(target: Element | string): void {
  if (typeof target === 'string') {
    overlayRootIds.add(target);
    return;
  }
  overlayRootElements.add(target);
  if (target.id) overlayRootIds.add(target.id);
}

/**
 * Remove a registration. Only needed by a future overlay that tears itself
 * down and is re-created; kept so the registry is not a write-only list.
 */
export function unregisterOverlayRoot(target: Element | string): void {
  if (typeof target === 'string') {
    overlayRootIds.delete(target);
    return;
  }
  overlayRootElements.delete(target);
}

/** Test seam: is this id currently registered? */
export function isRegisteredOverlayId(id: string): boolean {
  return overlayRootIds.has(id);
}

/** Test seam: reset the registry between cases. */
export function resetOverlayRoots(): void {
  overlayRootIds.clear();
}

/**
 * Is `node`, or any ancestor it can reach, an extension-owned overlay?
 *
 * Walks three kinds of edge, because the extension's UI uses all of them:
 *
 *   - shadow boundaries, via `getRootNode().host` (the roots are `open`, so
 *     the host is reachable; a *closed* root would stop the walk, which is the
 *     correct fail-closed answer)
 *   - ordinary parent nodes
 *   - the element itself
 *
 * Returns false for null, and for a node it cannot walk, rather than throwing.
 * A guard that throws is worse than a guard that says "I don't know".
 */
export function isOwnOverlayNode(node: unknown): boolean {
  let cur: Node | null = node as Node | null;
  // Depth-bounded: a malformed tree must not spin the guard.
  for (let depth = 0; cur && depth < 256; depth++) {
    // Shadow boundary FIRST, and only once. A shadow child has no
    // `parentNode` link to the host, so this hop is the only way to reach it.
    //
    // There is deliberately no second getRootNode()-based path here. There
    // was, and it was redundant: removing the `instanceof ShadowRoot` branch
    // still left every test green, because getRootNode() walked the same edge.
    // Two implementations of one behaviour is how they drift - and the only
    // way it was noticed was by mutating one and watching the suite not care.
    const root = typeof (cur as Element).getRootNode === 'function' ? cur.getRootNode() : null;
    if (root !== cur && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
      cur = root.host;
      continue;
    }
    if (cur instanceof Element) {
      if (overlayRootElements.has(cur)) return true;
      if (cur.id && overlayRootIds.has(cur.id)) return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

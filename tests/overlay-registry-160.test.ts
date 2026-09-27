/**
 * #160 — the occlusion guard learns about our own overlay UI.
 *
 * `isCovered()` in actions.ts is a fail-closed guard: it hit-tests a target's
 * centre and refuses the action if another node is on top. Correct, and
 * deliberately conservative — an indeterminate hit means "proceed".
 *
 * These tests pin both halves of the change:
 *   - a target under a REGISTERED extension overlay is not "covered"
 *   - a target under a third-party overlay still is (fail-closed preserved)
 *
 * The second is the one that matters. A perf/ergonomics fix that quietly
 * weakens a safety guard is worse than the bug it fixes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  registerOverlayRoot,
  unregisterOverlayRoot,
  isOwnOverlayNode,
  isRegisteredOverlayId,
} from '../src/lib/overlayRegistry';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isOwnOverlayNode recognises the extension’s own UI', () => {
  it('matches a registered host by element id', () => {
    const host = document.createElement('div');
    host.id = '__agent-nudge';
    document.body.appendChild(host);
    registerOverlayRoot('__agent-nudge');
    expect(isOwnOverlayNode(host)).toBe(true);
  });

  it('matches a node INSIDE a registered host', () => {
    const host = document.createElement('div');
    host.id = '__agent-nudge';
    const button = document.createElement('button');
    host.appendChild(button);
    document.body.appendChild(host);
    registerOverlayRoot('__agent-nudge');
    expect(isOwnOverlayNode(button)).toBe(true);
  });

  it('matches a node inside an OPEN shadow root of a registered host', () => {
    // This is the shape the cursor uses: host in the light DOM, inner nodes in
    // an open shadow root. The walk has to cross the shadow boundary, which
    // `parentNode` alone cannot do.
    const host = document.createElement('div');
    host.id = '__agent-nudge';
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.appendChild(inner);
    document.body.appendChild(host);
    registerOverlayRoot('__agent-nudge');
    expect(isOwnOverlayNode(inner)).toBe(true);
  });

  it('matches a host registered by element reference, with no id', () => {
    const host = document.createElement('div');
    const child = document.createElement('div');
    host.appendChild(child);
    document.body.appendChild(host);
    registerOverlayRoot(host);
    expect(isOwnOverlayNode(child)).toBe(true);
  });

  it('unregistering stops the match', () => {
    const host = document.createElement('div');
    host.id = '__agent-nudge';
    document.body.appendChild(host);
    registerOverlayRoot('__agent-nudge');
    unregisterOverlayRoot('__agent-nudge');
    expect(isOwnOverlayNode(host)).toBe(false);
  });
});

describe('fail-closed: anything not ours is still a coverer', () => {
  it('does not match a third-party overlay', () => {
    const overlay = document.createElement('div');
    overlay.id = 'some-other-widget';
    document.body.appendChild(overlay);
    expect(isOwnOverlayNode(overlay)).toBe(false);
  });

  it('does not match an ancestor of the target either', () => {
    // A page element that merely CONTAINS the target is a real coverer, and
    // isCovered() already treats an ancestor hit as covered on purpose.
    const wrapper = document.createElement('div');
    wrapper.id = 'page-wrapper';
    const field = document.createElement('input');
    wrapper.appendChild(field);
    document.body.appendChild(wrapper);
    expect(isOwnOverlayNode(wrapper)).toBe(false);
  });

  it('does not match a similarly-named id', () => {
    // Prefix-matching would be a hole: a page could call its own element
    // `__agent-nudge-fake` and opt itself out of the guard.
    const fake = document.createElement('div');
    fake.id = '__agent-nudge-shadow';
    document.body.appendChild(fake);
    registerOverlayRoot('__agent-nudge');
    expect(isOwnOverlayNode(fake)).toBe(false);
  });

  it('survives a null, undefined or non-node input', () => {
    // The guard must never throw — a throw inside isCovered() would turn a
    // recoverable "covered" answer into a crash.
    expect(isOwnOverlayNode(null)).toBe(false);
    expect(isOwnOverlayNode(undefined)).toBe(false);
    expect(isOwnOverlayNode('a string')).toBe(false);
    expect(isOwnOverlayNode(42)).toBe(false);
  });

  it('terminates on a detached subtree rather than spinning', () => {
    // A node with no parent and no shadow root: the walk must stop, not loop.
    const orphan = document.createElement('div');
    expect(isOwnOverlayNode(orphan)).toBe(false);
  });
});

describe('the shipped overlays are registered', () => {
  // Both current overlays are `pointer-events: none`, so the guard is already
  // immune to them. They are registered anyway so the immunity is a CONTRACT
  // rather than a coincidence of each overlay remembering to opt out of
  // pointer events — an interactive nudge control will break that.
  //
  // The two modules are imported for the SIDE EFFECT of their top-level
  // `registerOverlayRoot(...)` call. Asserting on the registry without
  // importing them would pass against an empty registry and prove nothing -
  // which is exactly what the first version of this test did (2 failures).
  it('registers the cursor host when agentCursor is loaded', async () => {
    expect(isRegisteredOverlayId('__agent-cursor')).toBe(false);
    await import('../src/lib/agentCursor');
    expect(isRegisteredOverlayId('__agent-cursor')).toBe(true);
  });

  it('registers the highlight box id as a plain id', () => {
    // The highlight constant lives in content.ts, an entrypoint that cannot be
    // imported here (it calls defineContentScript at module scope). Assert the
    // registration by reading the source - the point of the test is that the
    // shipped id is the one the registry is asked to recognise, not that the
    // entrypoint's module side effect ran.
    const content = readFileSync('src/entrypoints/content.ts', 'utf-8');
    expect(content, 'content.ts does not register the highlight').toMatch(
      /registerOverlayRoot\(HIGHLIGHT_ID\)/
    );
    // The constant really is the id the registry will be given.
    expect(content).toMatch(/const HIGHLIGHT_ID = '__agent-highlight'/);
    // And that id is registrable through the public API.
    registerOverlayRoot('__agent-highlight');
    expect(isRegisteredOverlayId('__agent-highlight')).toBe(true);
  });
});

/**
 * End-to-end through the real guard.
 *
 * `isCovered` is module-private, so these drive the public `execute()` entry,
 * which reaches it via `rejectIfCovered`. Without this block every test above
 * would still pass if someone deleted the single line in actions.ts that wires
 * the registry in - the unit and the integration are separate claims.
 *
 * The target is registered through `registerGroundedElement` because that is
 * the real extract-time path that populates the element registry `resolve()`
 * reads; a bare `document.createElement` is never findable by id.
 */
describe('isCovered, through the public execute() entry', () => {
  /** Register a real field and return the id execute() will accept. */
  async function registerField() {
    const { registerGroundedElement } = await import('../src/lib/dom');
    const field = document.createElement('input');
    field.type = 'text';
    field.setAttribute('aria-label', 'name');
    document.body.appendChild(field);
    // jsdom reports a zero rect for everything, and isCovered() bails on
    // `!rect.width || !rect.height` BEFORE it ever hit-tests. Give the field a
    // real box so the test actually exercises the guard instead of its
    // zero-size shortcut.
    field.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 30, right: 210, bottom: 50 }) as DOMRect;
    const rec = registerGroundedElement(field, 'name field');
    return { field, id: rec!.id };
  }

  it('refuses a target under a THIRD-PARTY overlay (fail-closed, unchanged)', async () => {
    const { id } = await registerField();
    const thirdParty = document.createElement('div');
    thirdParty.id = 'cookie-banner';
    document.body.appendChild(thirdParty);
    // The hit-test finds the cookie banner at the field's centre.
    document.elementFromPoint = () => thirdParty;

    const { execute } = await import('../src/lib/actions');
    // execute() catches action errors and returns {ok:false, error}; it never
    // rejects. Assert the RESULT shape, not a thrown error.
    const res = await execute({ type: 'CLICK', targetId: id });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/covered/i);
  });

  it('allows a click when only OUR overlay is on top', async () => {
    const { field, id } = await registerField();
    const nudge = document.createElement('div');
    nudge.id = '__agent-nudge';
    const btn = document.createElement('button');
    nudge.appendChild(btn);
    document.body.appendChild(nudge);
    registerOverlayRoot('__agent-nudge');
    document.elementFromPoint = () => btn;
    let clicked = false;
    field.addEventListener('click', () => {
      clicked = true;
    });

    const { execute } = await import('../src/lib/actions');
    const res = await execute({ type: 'CLICK', targetId: id });
    expect(res.ok, `action refused: ${String(res.error)}`).toBe(true);
    expect(clicked).toBe(true);
  });
});

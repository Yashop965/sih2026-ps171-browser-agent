/**
 * Tests for the KEY action (issue #84).
 *
 * The agent previously could TYPE into a search box but had no way to press
 * Enter, so it could never submit a search that a real user would finish with
 * a keypress. This covers:
 *   - KEY dispatches a full keydown/keypress/keyup triple
 *   - a named key ("Enter") and a single printable char resolve to sane codes
 *   - an unknown/multi-char key name that is not a known key throws
 *   - KEY is exempted from auto-retry (a keypress may navigate / re-focus)
 *   - the executor routes KEY through doKey (not the default-throw branch)
 *
 * `keyCode` is a deprecated alias and is not reliably populated in jsdom, so
 * the assertions rely on the standard `key` / `code` properties instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execute, executeWithRetry } from '../src/lib/actions';

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) => undefined,
  getElementByStableId: (id: string) => undefined,
  // #118: no guards captured -> resolve() skips the freshness check.
  getGuardForId: () => undefined,
  getGuardForStableId: () => undefined,
  verifyElementFreshness: () => true,
}));

// Capture the keydown/keypress/keyup events that doKey dispatches.
// doKey dispatches on the target element (document.body when no targetId),
// and events bubble to <document> — so we listen at document. (Overriding
// document.dispatchEvent directly would NOT see them: bubbling does not
// re-enter the overridden dispatchEvent; it completes in the engine.)
const keyEvents: KeyboardEvent[] = [];
let keyListener: (ev: Event) => void;

function installKeyCapture() {
  keyEvents.length = 0;
  keyListener = (ev: Event) => {
    if (ev instanceof KeyboardEvent) keyEvents.push(ev);
  };
  document.addEventListener('keydown', keyListener, true);
  document.addEventListener('keypress', keyListener, true);
  document.addEventListener('keyup', keyListener, true);
}

function restoreKeyCapture() {
  document.removeEventListener('keydown', keyListener, true);
  document.removeEventListener('keypress', keyListener, true);
  document.removeEventListener('keyup', keyListener, true);
}

describe('KEY action (issue #84)', () => {
  beforeEach(installKeyCapture);
  afterEach(restoreKeyCapture);

  it('presses Enter: dispatches keydown + keypress (printable) + keyup with key Enter', async () => {
    const result = await execute({ type: 'KEY', key: 'Enter' });
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/unknown/i);
    expect(keyEvents.length).toBeGreaterThanOrEqual(2);
    const types = keyEvents.map((e) => e.type);
    expect(types).toContain('keydown');
    expect(types).toContain('keyup');
    // Enter is printable in doKey's KEY_MAP, so a keypress is emitted too.
    expect(types).toContain('keypress');
    const down = keyEvents.find((e) => e.type === 'keydown')!;
    expect(down.key).toBe('Enter');
    expect(down.code).toBe('Enter');
  });

  it('resolves a single printable character to a KeyX code', async () => {
    const result = await execute({ type: 'KEY', key: 'a' });
    expect(result.ok).toBe(true);
    const down = keyEvents.find((e) => e.type === 'keydown')!;
    expect(down.key).toBe('a');
    expect(down.code).toBe('KeyA');
  });

  it('defaults to Enter when key is omitted', async () => {
    const result = await execute({ type: 'KEY' });
    expect(result.ok).toBe(true);
    expect(keyEvents.find((e) => e.type === 'keydown')!.key).toBe('Enter');
  });

  it('presses on the FOCUSED element when targetId is null (Bug: "element null not found")', async () => {
    // The planner emits KEY with targetId: null to mean "submit the search
    // box I just typed into" (i.e. press Enter on whatever has focus). A
    // null targetId must NOT be resolved through the element registry (that
    // throws "element null not found" and the Enter never fires); it should
    // fall through to the active element / body.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = await execute({ type: 'KEY', key: 'Enter', targetId: null as unknown as number });
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/null|not found/i);
    input.remove();
  });

  it('presses on the FOCUSED element when targetId is absent', async () => {
    const result = await execute({ type: 'KEY', key: 'Enter' });
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/not found/i);
  });

  it('rejects an unknown multi-char key that is not a known key name', async () => {
    const result = await execute({ type: 'KEY', key: 'NotAKey' });
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/unknown key/i);
  });

  it('is exempt from auto-retry in executeWithRetry (no double-press)', async () => {
    // A KEY action that "fails" (unknown key) must not be re-run by
    // executeWithRetry, mirroring NAVIGATE/DONE/WAIT. We observe that the
    // executor does NOT throw "unknown action type" (i.e. KEY is routed to
    // doKey, not the default branch) and that the no-retry path returns after
    // the single failed attempt.
    const result = await executeWithRetry({ type: 'KEY', key: 'Nope' });
    expect(result.ok).toBe(false);
    // If KEY were unknown to execute(), the error would say so.
    expect(result.error ?? '').not.toMatch(/unknown action type/i);
  });

  it('is recognized by the executor switch (not the default-throw branch)', async () => {
    const result = await execute({ type: 'KEY', key: 'Tab' });
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/unknown action type/i);
  });

  it('#114: Enter on an input inside a <form> actually submits the form', async () => {
    // Live bug (2026-09-19 3-hop run): the planner issued KEY Enter on the
    // Wikipedia search box after typing, and doKey only dispatched synthetic
    // KeyboardEvents - which are untrusted and do NOT trigger native form
    // submission in Chromium. The form sat unsubmitted and the agent looped
    // re-typing for 10 steps. doKey must now call form.requestSubmit() when
    // the key is Enter and the target is inside a <form>.
    const form = document.createElement('form');
    const input = document.createElement('input');
    form.appendChild(input);
    document.body.appendChild(form);

    let submitted = 0;
    const submitHandler = (ev: Event) => {
      ev.preventDefault();
      submitted += 1;
    };
    form.addEventListener('submit', submitHandler);

    input.focus();
    const result = await execute({ type: 'KEY', key: 'Enter', targetId: null as unknown as number });
    expect(result.ok).toBe(true);
    expect(submitted).toBe(1);

    form.removeEventListener('submit', submitHandler);
    form.remove();
  });

  it('#114: Enter with no enclosing form does not throw (no form to submit)', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = await execute({ type: 'KEY', key: 'Enter' });
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/unknown|not found/i);
    input.remove();
  });
});

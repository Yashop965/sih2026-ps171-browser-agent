/**
 * #208 — recognise goals that OCR can never prove, and verify them from the DOM.
 *
 * ## The ceiling
 *
 * `visionConfirm` proves a goal by finding its target **text** in the OCR of the
 * visible screen. That works for goals that name something visible ("the order
 * confirmation banner"), and cannot work for goals that name an **action**:
 *
 *     "Tick the terms of service checkbox"
 *
 * A ticked checkbox is a *state change*, not a string. There is no on-screen
 * text that appears when it is ticked, so `targetInOcr` is permanently false and
 * the verdict is permanently `confirmed: false`.
 *
 * Observed live on 2026-09-28 and 09-29: the run reached 10/11 and then
 * `OCR missing target(s): 11` repeated until the step budget ran out. The agent
 * had done all the work correctly and was still reported as unfinished.
 *
 * **The gate is fail-closed and therefore safe** — refusing to claim success it
 * cannot prove. The defect is that it has no way to say "I cannot verify this
 * kind of goal", so a structural ceiling is indistinguishable from a stuck task.
 *
 * ## Two fixes, and why both
 *
 * **1. Classify the goal.** An action-phrased item is `unverifiable` by OCR. It
 * must be reported as such rather than as `missing`, so the log stops repeating a
 * line that means "this can never pass" and starts saying so once.
 *
 * **2. Verify it from the DOM instead.** The content script already knows
 * whether a checkbox is checked or a button is pressed — a far stronger signal
 * than reading pixels. A checkbox goal is confirmed by `checked === true`.
 *
 * ## What this deliberately does NOT do
 *
 * **It does not weaken the gate.** An unverifiable goal is NOT counted as
 * confirmed. It is reported as unverifiable, and the deterministic backstop still
 * owns completion. This changes what we *say* about the ceiling and adds a
 * stronger check where one is available — it does not turn "cannot prove" into
 * "assume yes".
 *
 * ## The honest limit
 *
 * A goal like "submit the form" has no single checkbox to read either. It stays
 * unverifiable by this mechanism, and will still cap a run. That is correct: the
 * only honest signals for it are the submit action's own result and the
 * subsequent page change, which is a larger change than this issue.
 */

import { describe, it, expect } from 'vitest';
import { isActionGoal, checkboxSatisfied } from '../src/lib/actionGoal';

describe('#208 action goals are recognised as unverifiable by OCR', () => {
  it('classifies a tick-the-checkbox goal as an action', () => {
    expect(isActionGoal('Tick the terms of service checkbox')).toBe(true);
    expect(isActionGoal('tick terms')).toBe(true);
    expect(isActionGoal('Check the "I agree" box')).toBe(true);
  });

  it('classifies submit / send / press goals as actions', () => {
    expect(isActionGoal('Submit the form')).toBe(true);
    expect(isActionGoal('Send the message')).toBe(true);
    expect(isActionGoal('Press Enter to confirm')).toBe(true);
  });

  it('does NOT classify a text goal as an action', () => {
    // The regression that matters most: ordinary confirmable goals must keep
    // going down the OCR path, or this fix breaks every working task.
    expect(isActionGoal('Order confirmation banner is visible')).toBe(false);
    expect(isActionGoal('Dashboard shows 12 invoices')).toBe(false);
    expect(isActionGoal('Welcome back Priya')).toBe(false);
  });

  it('does not fire on a word that merely appears in a text goal', () => {
    // "Send" inside "Sender address is shown" is not an action.
    expect(isActionGoal('Sender address is displayed')).toBe(false);
  });

  it('handles an empty description without claiming it is an action', () => {
    // An unknown goal must stay in the existing "cannot prove" bucket, not be
    // reclassified as an action on no evidence.
    expect(isActionGoal('')).toBe(false);
    expect(isActionGoal(undefined)).toBe(false);
  });
});

describe('#208 a checkbox goal is verified from DOM state, not pixels', () => {
  it('is satisfied when the named checkbox is checked', () => {
    expect(checkboxSatisfied('terms', { terms: true, tos: false })).toBe(true);
  });

  it('is NOT satisfied while the checkbox is unchecked', () => {
    // The whole point: unchecked must fail, or the check proves nothing.
    expect(checkboxSatisfied('terms', { terms: false })).toBe(false);
  });

  it('is NOT satisfied when the checkbox is absent from the page', () => {
    // Absent is not checked. Defaulting to true here would let a task claim
    // completion for a control that is not on the page.
    expect(checkboxSatisfied('terms', {})).toBe(false);
  });

  it('tolerates a control named by its label rather than an abbreviation', () => {
    // The planner writes "terms of service"; a real page's control is named by
    // its label text, and readCheckboxState prefers name/id/aria-label/label —
    // so word-level matching resolves it.
    expect(checkboxSatisfied('terms of service', { terms: true })).toBe(true);
    expect(checkboxSatisfied('Tick the terms of service checkbox', { terms: true })).toBe(true);
  });

  it('does NOT guess an acronym to the words it abbreviates', () => {
    // Deliberate limit, pinned so it is a decision and not a surprise. A control
    // named `tos` does not match a goal reading "terms of service" - expanding
    // acronyms would be a guess, and a wrong guess here means claiming a goal is
    // done when it is not. The result is `unverifiable`, which is safe.
    expect(checkboxSatisfied('terms of service', { tos: true })).toBe(false);
  });

  it('is false for a state map with no boolean values', () => {
    expect(checkboxSatisfied('terms', { terms: 'yes' as unknown as boolean })).toBe(false);
  });

  it('an UNNAMED checkbox never satisfies a goal', () => {
    // Mutation testing found this: dropping the empty-control guard made an
    // empty control name match any goal, so a page's first anonymous checkbox
    // would prove "tick the terms of service". A goal must never be satisfied by
    // a control that cannot be identified.
    expect(checkboxSatisfied('terms of service', { '': true })).toBe(false);
    expect(checkboxSatisfied('terms of service', { '   ': true })).toBe(false);
    // A real page's anonymous box is keyed checkbox-N, which carries no goal
    // words and must not match either.
    expect(checkboxSatisfied('terms of service', { 'checkbox-0': true })).toBe(false);
  });
});

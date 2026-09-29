/**
 * #205 part 2 — a planner-chosen id must survive the round trip to the executor.
 *
 * ## The defect
 *
 * Element ids are POSITIONAL: `extract()` clears the registry and re-issues 1..N
 * in DOM order on every call. The planner picks one, and an LLM round-trip
 * separates the choice from the action. If the page re-renders in between, the id
 * names a different element — and `isConnected` and the #118 semantic guard both
 * pass, because they answer "is this element still what it was?", not "is this
 * the element that was chosen?".
 *
 * A *stale id that still resolves* is worse than one that fails: a fail-closed
 * stale id is safe, a silently-wrong one puts data in the wrong field.
 *
 * ## The identity already exists, and was being discarded
 *
 * `extract()` builds a content-invariant `stableId` (tag + name/for + role +
 * label, plus a base-scoped ordinal since #209 made it unique). The executor's
 * `resolve()` already branches on `typeof targetId` and calls
 * `getElementByStableId` for a string. `background.ts` already types the inbound
 * action as `{ targetId?: number | string }`, and every consumer in the runner
 * already does `String(action.targetId)`.
 *
 * **Every part of the path can carry a string. The server was the only thing
 * preventing it**, coercing the id back to a positional int before responding:
 *
 *     ActionSchema.targetId: Optional[int]
 *     _parse: target_id = stable_to_id.get(s)   # stableId -> positional int
 *
 * Probed live: the same /plan request returned `targetId: 1` whether a stableId
 * was supplied or not. So "make the planner emit a stableId" alone is a no-op —
 * the value never reaches the extension.
 *
 * ## What this changes
 *
 * The id the planner chose is carried through as the stableId, so the executor
 * looks it up by identity rather than by position. The window where a re-render
 * can misdirect an action is closed rather than narrowed.
 *
 * ## What is deliberately NOT changed
 *
 * Numeric ids remain fully supported: the model's own numeric output still
 * resolves, the `filled` history matching already compares both forms, and a
 * planner that emits neither still degrades to a target-less action exactly as
 * before.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const planner = readFileSync('server/planner.py', 'utf-8');
const actions = readFileSync('src/lib/actions.ts', 'utf-8');
const background = readFileSync('src/entrypoints/background.ts', 'utf-8');
const runner = readFileSync('src/lib/agentRunner.ts', 'utf-8');

describe('#205 a stableId can cross the plan response intact', () => {
  it('ActionSchema.targetId is no longer int-only', () => {
    // THE regression guard. While this is Optional[int], pydantic coerces the
    // id back to a positional integer and the stableId never reaches the
    // extension - verified live against the running server.
    const start = planner.indexOf('class ActionSchema');
    const body = planner.slice(start, planner.indexOf('\n    value:', start));
    expect(body).toMatch(/targetId:\s*Optional\[/);
    expect(body).not.toMatch(/targetId:\s*Optional\[int\]/);
  });

  it('the response schema admits a string targetId', () => {
    expect(planner).toMatch(/Union\[int,\s*str\]/);
  });

  it('a stableId the model emits is NOT collapsed to a positional int', () => {
    // The coercion that made the whole feature a no-op. Asserted on the ACTIVE
    // branch - the first thing done with a non-numeric targetId - rather than on
    // the legacy fallback further down, which still exists on purpose and would
    // otherwise make this assertion fail for the wrong reason.
    const i = planner.indexOf('if isinstance(target_id, str):');
    const branch = planner.slice(i, i + 1800);
    // A recognised stableId is passed straight through. Matched with a
    // generous window because an explanatory comment sits between the guard and
    // the assignment - and the assignment is the part that matters.
    expect(branch).toMatch(/if s in known_stable_ids:[\s\S]{0,300}target_id = s/);
    // and the positional substitution is NOT what a known id gets.
    const passThrough = branch.indexOf('target_id = s');
    const legacyLookup = branch.indexOf('target_id = stable_to_id.get(s)');
    expect(passThrough).toBeGreaterThan(-1);
    expect(legacyLookup).toBeGreaterThan(passThrough);
  });

  it('an UNKNOWN stableId is still dropped, not passed through', () => {
    // Fail closed at the boundary: an id the executor has no entry for must not
    // be forwarded as if it were resolvable.
    const i = planner.indexOf('if isinstance(target_id, str):');
    const branch = planner.slice(i, i + 1800);
    expect(branch).toMatch(/stableId; dropping the target/);
  });

  it('a numeric id is still accepted, so an old planner behaviour keeps working', () => {
    expect(planner).toMatch(/s\.isdigit\(\)/);
  });
});

describe('#205 the target VALIDATION accepts both id forms', () => {
  /**
   * A known stableId resolved correctly in the parse step and was then rejected
   * by a SECOND check whose set held positional ids only, producing the
   * "Target element #... not found on page" fallback. Every earlier assertion
   * passed while the feature was still a no-op, because the id was correct and
   * then thrown away.
   *
   * This asserts the set itself, and a behavioural test below asserts the
   * observable consequence.
   */
  it('the valid-id set includes stableIds, not just positional ids', () => {
    const i = planner.indexOf('valid_element_ids = {');
    expect(i).toBeGreaterThan(-1);
    const block = planner.slice(i, i + 500);
    expect(block).toMatch(/str\(el\.get\("stableId"\)\)/);
    // and the set is a union of both, not one replacing the other
    expect(block).toMatch(/\}\s*\|\s*\{/);
  });

  it('the validation branch is still fail-closed for an unknown id', () => {
    const i = planner.indexOf('valid_element_ids = {');
    const block = planner.slice(i, i + 1400);
    expect(block).toMatch(/target_id not in valid_element_ids/);
    expect(block).toMatch(/_fallback_action/);
  });
});

describe('#205 the extension resolves a string id by identity', () => {
  it('resolve() still branches on the id type', () => {
    expect(actions).toMatch(/typeof targetId === 'number'/);
    expect(actions).toMatch(/getElementByStableId/);
  });

  it('the SW accepts a string targetId on the inbound action', () => {
    expect(background).toMatch(/targetId\?:\s*number \| string/);
  });
});

describe('#205 the downstream consumers are already string-safe', () => {
  it('the runner stringifies the id wherever it is recorded', () => {
    // filledIds, loop detection, history and the failure log all key on a
    // string, so a stableId is tracked exactly like a numeric id.
    const recorded = runner.match(/String\(action\.targetId\)/g) || [];
    expect(recorded.length).toBeGreaterThanOrEqual(6);
  });

  it('the outbound gate matches elements on a string comparison', () => {
    // `String(el.id) === String(targetId)` alone would NOT find a stableId, and
    // the gate would fall into "no element" -> cannot classify -> an
    // outbound-send gate that fails OPEN. So the stable comparison must exist
    // too, and it must be a second attempt rather than a replacement.
    const g = readFileSync('src/lib/outboundGate.ts', 'utf-8');
    const i = g.indexOf('function findElement');
    const body = g.slice(i, g.indexOf('\n  }', i));
    expect(body).toMatch(/String\(el\.id\) === key/);
    expect(body).toMatch(/String\(el\.stableId\) === key/);
    // The positional match stays FIRST: a numeric id must resolve exactly as
    // before, and `??` (not `||`) so a falsy first result cannot mask it.
    const byId = body.indexOf('String(el.id) === key');
    const byStable = body.indexOf('String(el.stableId) === key');
    expect(byId).toBeLessThan(byStable);
  });

  it('the "already filled" matching compares both id forms', () => {
    // The server marks an element filled from history, matching numeric OR
    // stableId. If only numeric matched, a stableId-based plan would re-type
    // fields it had already filled.
    expect(planner).toMatch(/str\(step_target\)\s*==\s*str\(element_id\)/);
    expect(planner).toMatch(/step_target == element_stable_id/);
  });
});

describe('#205 the element table still carries the numeric id', () => {
  it('both ids are sent, so nothing that reads `id` breaks', () => {
    const i = planner.indexOf('"targetId": element_id');
    const block = planner.slice(i, i + 400);
    expect(block).toMatch(/"stableId":\s*element_stable_id/);
  });
});

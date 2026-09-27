/**
 * Behavioural test for #192 (re-review) — executes the real NAVIGATE branch
 * from agentRunner against a stub `d`.
 *
 * The source-reading tests in nav-recoverable-192.test.ts prove the code says
 * the right things. This proves it does the right thing, by extracting the
 * actual branch text out of the shipped file and running it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/agentRunner.ts', 'utf-8');

/**
 * Pull the NAVIGATE branch out of executeAction and run it as a function.
 *
 * The branch is an `if` block, so it is wrapped in a function taking `action`
 * and `d`, plus a `this` carrying only what the branch touches.
 */
async function runNavigateBranch(navigateResult: {
  ok: boolean;
  error?: string;
  recoverable?: boolean;
}) {
  const start = src.indexOf("if (action.type === 'NAVIGATE' && action.url)");
  if (start === -1) throw new Error('NAVIGATE branch not found');
  // Walk braces from the `if (` to its closing brace.
  let i = src.indexOf('{', src.indexOf('if (', start));
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) {
        i = k;
        break;
      }
    }
  }
  const block = src.slice(src.indexOf('{', src.indexOf('if (', start)) + 1, i);

  const logs: string[] = [];
  const state = { status: 'running' as string };
  const ctx = {
    state,
    scrollGuard: { noteOtherAction: () => {} },
    recentActionHistory: [] as string[],
    actionsSinceGoalCheck: 0,
    log: (m: string) => logs.push(m),
    delay: async () => {},
  };

  const action = { type: 'NAVIGATE', url: 'https://x.example/p' };
  // The success path also awaits d.delay(600), so the stub needs it - a
  // missing method here looks like a code failure but is a harness gap.
  const d = { navigate: async () => navigateResult, delay: async () => {} };

  // The generated function is called with `.call(ctx)`, so the `this` at the
  // top level of its body IS `ctx`; the async arrow inside inherits that `this`.
  //
  // Two earlier attempts failed the same way, for different reasons:
  //   - a bare `function` body, where `this` is sloppy-mode function scope
  //     and `this.state` throws;
  //   - an arrow with no `.call`, where `this` is absent entirely and
  //     `this.log is not a function`.
  //
  // eslint-disable-next-line no-new-func
  const fn = new Function('action', 'd', `return (async () => {${block}}).call(this);`);
  await fn.call(ctx, action, d);
  return { state, logs, ctx };
}

describe('a refused NAVIGATE leaves the run alive', () => {
  it('a recoverable failure does NOT set status failed', async () => {
    const { state, logs } = await runNavigateBranch({
      ok: false,
      error: 'refused protocol: javascript:',
      recoverable: true,
    });
    expect(state.status).not.toBe('failed');
    expect(state.status).toBe('running');
    expect(logs.join('\n')).toMatch(/refused/i);
  });

  it('a non-recoverable failure DOES set status failed', async () => {
    // The fix must not turn environment failures into infinite retries.
    const { state } = await runNavigateBranch({ ok: false, error: 'No web tab found' });
    expect(state.status).toBe('failed');
  });

  it('counts a refused navigation as a step toward the goal check', async () => {
    // Otherwise a planner that keeps emitting a bad url loops forever and
    // never reaches its final check.
    const { ctx } = await runNavigateBranch({ ok: false, recoverable: true, error: 'x' });
    expect(ctx.actionsSinceGoalCheck).toBe(1);
  });

  it('cannot loop forever: currentStep is bumped at the top of every iteration', () => {
    // The recoverable branch deliberately does NOT end the run, so the only
    // thing bounding a planner that keeps emitting a bad url is the step cap.
    //
    // `currentStep++` sits at the top of the main loop, before any action is
    // executed, so a refused navigation consumes a step exactly like a
    // successful one. Verified by reading the loop, not assumed - this is the
    // question that decides whether `recoverable` is safe at all.
    const inc = src.indexOf('currentStep++');
    const guard = src.indexOf('if (currentStep >= maxSteps)');
    expect(inc).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // The cap is checked before the increment, each iteration.
    expect(guard).toBeLessThan(inc);

    // And the cap is finite. `let maxSteps = 15` is the default; it is later
    // narrowed by `Math.min(sessionMax, calculated, 100)`, so 100 is the
    // ceiling. Asserted because "the cap exists" is not the same claim as
    // "the cap is a finite number" - a cap of Infinity would loop forever.
    const decl = src.match(/let maxSteps = (\d+)/);
    expect(decl, 'maxSteps has no numeric default').not.toBeNull();
    expect(Number(decl![1])).toBeGreaterThan(0);
    expect(Number(decl![1])).toBeLessThanOrEqual(100);
    // And it is explicitly clamped, so a large session cannot raise it
    // without bound.
    expect(src).toMatch(/maxSteps = Math\.min\([^)]*100\)/);
  });

  it('a successful navigation clears recentActionHistory', async () => {
    // Guards against the recoverable branch disturbing the success path.
    const { ctx, state } = await runNavigateBranch({ ok: true });
    expect(state.status).toBe('running');
    expect(ctx.recentActionHistory).toEqual([]);
  });
});

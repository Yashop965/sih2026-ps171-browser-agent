/**
 * #192 (re-review) — a refused NAVIGATE was killing the whole run.
 *
 * agentRunner's NAVIGATE branch treated every `ok: false` identically:
 *
 *   if (r.ok) { ... } else { this.state.status = 'failed'; }
 *
 * `failed` is terminal — the goal backstop skips it and the run ends. So #192's
 * new `needsBase` refusal, and the pre-existing `javascript:` refusal, did not
 * waste a step. They terminated a task that was one malformed url away from
 * finishing.
 *
 * Fixed with a `recoverable` flag on the navigate result: a bad instruction
 * leaves the run alive so the planner is told and can re-plan; a real
 * environment failure (no web tab, thrown error, failed load) stays fatal.
 *
 * The security behaviour is unchanged. `javascript:` is still refused, and the
 * tab still does not navigate. Only what happens to the RUN afterwards differs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const runner = readFileSync('src/lib/agentRunner.ts', 'utf-8');
const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');

function navBranch(): string {
  const i = runner.indexOf("if (action.type === 'NAVIGATE' && action.url)");
  const end = runner.indexOf("if (action.type === 'SWITCH_TAB')", i);
  return runner.slice(i, end === -1 ? i + 1500 : end);
}

describe('a recoverable navigation failure does not end the run', () => {
  it('branches on recoverable before failing', () => {
    const b = navBranch();
    const recoverableAt = b.indexOf('r.recoverable');
    const failedAt = b.indexOf("status = 'failed'");
    expect(recoverableAt).toBeGreaterThan(-1);
    expect(failedAt).toBeGreaterThan(-1);
    // The recoverable branch must come FIRST, or a refused url still fails.
    expect(recoverableAt).toBeLessThan(failedAt);
  });

  it('does not set failed in the recoverable branch', () => {
    const b = navBranch();
    const recoverableAt = b.indexOf('r.recoverable');
    const failedAt = b.indexOf("status = 'failed'");
    // Between the recoverable test and the failure there must be a `}`, so
    // the recoverable branch cannot be the one setting failed.
    const between = b.slice(recoverableAt, failedAt);
    expect(between).toContain('} else');
    expect(between).not.toContain("status = 'failed'");
  });

  it('still fails the run on a NON-recoverable error', () => {
    // The fix must not turn every navigation failure into a retry loop.
    const b = navBranch();
    expect(b).toContain('} else {');
    expect(b).toContain("this.state.status = 'failed'");
  });

  it('counts a refused navigation as a step toward the goal check', () => {
    // Without this, a planner that keeps emitting a bad url could loop
    // forever and never reach its final goal check.
    const b = navBranch();
    const i = b.indexOf('r.recoverable');
    const j = b.indexOf("status = 'failed'");
    expect(b.slice(i, j)).toContain('actionsSinceGoalCheck');
  });
});

describe('only url-policy refusals are marked recoverable', () => {
  it('marks the two policy refusals', () => {
    const i = bg.indexOf('const navigateChannel');
    const body = bg.slice(i, bg.indexOf('\n    };', i));
    // Field order is Prettier's choice and differs between the two returns
    // (one is a single line, one is wrapped), so match the object as a whole
    // rather than assuming `recoverable` comes before or after `error`.
    const returns = body.match(/return \{[^}]*(?:\{[^}]*\}[^}]*)*\};/g) ?? [];
    const recoverable = returns.filter((x) => x.includes('recoverable: true'));
    expect(recoverable.length).toBe(2);
    // And they are the url-policy ones, not the environment ones.
    expect(recoverable.some((x) => x.includes('nav.error'))).toBe(true);
    expect(recoverable.some((x) => x.includes('relative url'))).toBe(true);
  });

  it('leaves environment failures fatal', () => {
    const i = bg.indexOf('const navigateChannel');
    const body = bg.slice(i, bg.indexOf('\n    };', i));
    // No web tab, and the catch-all, must NOT claim to be recoverable.
    expect(body).toContain("return { ok: false, error: 'No web tab found' };");
    expect(body).not.toMatch(/No web tab found'[^\n]*recoverable/);
    expect(body).not.toMatch(/error: String\(e\)[^\n]*recoverable/);
  });
});

describe('#192 (re-review): the planner now checks, not just asks', () => {
  const planner = readFileSync('server/planner.py', 'utf-8');

  it('rejects a relative url at the planner instead of relying on the prompt', () => {
    // "MUST be absolute" in a prompt is a request. This is the check.
    expect(planner).toMatch(/raw_type == "NAVIGATE" and url:/);
    expect(planner).toContain('has_authority');
    expect(planner).toContain('NAVIGATE url must be absolute');
  });

  it('degrades to the same fallback a missing url uses', () => {
    // A relative url should cost a step, not the run.
    const i = planner.indexOf('NAVIGATE url must be absolute');
    const around = planner.slice(Math.max(0, i - 700), i + 200);
    expect(around).toContain('_fallback_action');
  });

  it('still allows absolute and protocol-relative urls through', () => {
    // Over-rejecting here would break every working navigation.
    expect(planner).toContain('"://" in candidate or candidate.startswith("//")');
  });
});

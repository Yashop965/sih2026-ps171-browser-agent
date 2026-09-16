/**
 * Loop detection + scroll-guard for the agent task loop (issue #76).
 *
 * Before this module, the "loop-detection" lived inline in the popup (and is
 * now in src/lib/agentRunner.ts) as a `recentActionHistory.slice(-5)` compare
 * plus a `consecutiveScrolls` counter - and the only "tests" for it built a
 * local mock array and asserted on it, which could pass forever no matter
 * what the real code did (audit P2 #S5). This module is the single source of
 * truth the loop uses, so it can be unit-tested directly:
 *
 *   - isRepeatedAction()  -> catches a duplicate planned action on the same
 *     element (e.g. the planner re-issues CLICK on the same submit button),
 *   - ScrollGuard        -> stops a "scroll storm" (the planner keeps issuing
 *     SCROLL with no progress),
 *   - calculateMaxSteps() -> the step budget, shared so the test and the loop
 *     can never drift.
 */

export interface RecentAction {
  targetId: string;
  type: string;
}

/**
 * True when the planner re-issues the exact same (targetId, type) action as
 * the previous one - e.g. re-clicking the same submit button or re-typing
 * the same field the moment it was just typed. Action types that carry no
 * element target (SCROLL / NAVIGATE / WAIT / DONE) have targetId undefined
 * and so never repeat here; their guard is separate (ScrollGuard + the
 * max-steps cap).
 */
export function isRepeatedAction(
  recentHistory: RecentAction[],
  action: { targetId?: number | string; type: string },
): boolean {
  if (action.targetId === undefined) return false;
  const last = recentHistory[recentHistory.length - 1];
  return (
    !!last &&
    String(last.targetId) === String(action.targetId) &&
    last.type === action.type
  );
}

/**
 * Binds the step budget to how many fields the planner must fill. Generous
 * (each field gets up to 3 steps + a submit + slack) but hard-capped so a
 * huge form can't run unbounded. Shared by the loop and the test so the two
 * can never disagree about the cap.
 */
export function calculateMaxSteps(
  inputCount: number,
  selectCount: number,
  buttonCount: number,
): number {
  const totalFields = inputCount + selectCount;
  const calculated = Math.max(20, totalFields * 3 + buttonCount + 10);
  return Math.min(100, calculated);
}

/**
 * Guards against a "scroll storm": the planner issuing SCROLL over and over
 * (no content revealed, no fields to fill). Counts consecutive scrolls and
 * stops the loop once it exceeds the threshold. A non-SCROLL action resets
 * the counter, so scrolls separated by real work never trip it.
 */
export class ScrollGuard {
  private scrolls = 0;

  constructor(
    private readonly maxConsecutive: number = 3,
  ) {}

  /**
   * Call before issuing a SCROLL. Returns the incremented count and whether
   * the scroll should still be allowed. Call `noteOtherAction()` after any
   * non-scroll action to reset the counter.
   */
  nextScroll(): { allowed: boolean; consecutive: number } {
    this.scrolls++;
    return { allowed: this.scrolls <= this.maxConsecutive, consecutive: this.scrolls };
  }

  /** Reset after any non-scroll action (TYPE / CLICK / SELECT / KEY / NAVIGATE). */
  noteOtherAction(): void {
    this.scrolls = 0;
  }

  get count(): number {
    return this.scrolls;
  }
}

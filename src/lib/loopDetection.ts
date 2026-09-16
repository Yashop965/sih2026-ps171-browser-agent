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
  value?: string;
}

/**
 * True when the planner re-issues the exact same action as the previous one.
 *
 * Value-blind repeat detection (comparing only targetId+type) breaks
 * legitimate re-use of a field: e.g. the agent searches "Web browser" in the
 * Wikipedia box, then searches "Progressive web app" in the SAME box — both
 * are TYPE on the same targetId, but with different values, so the second is
 * real progress, not a loop. For value-bearing actions we therefore only flag
 * a repeat when the value is identical; a different value is a fresh action.
 * Action types that carry no element target (SCROLL / NAVIGATE / WAIT / DONE)
 * have targetId undefined and never repeat here (their guard is the
 * ScrollGuard + max-steps cap).
 */
export function isRepeatedAction(
  recentHistory: RecentAction[],
  action: { targetId?: number | string; type: string; value?: string },
): boolean {
  if (action.targetId === undefined) return false;
  const last = recentHistory[recentHistory.length - 1];
  if (!last) return false;
  if (String(last.targetId) !== String(action.targetId)) return false;
  if (last.type !== action.type) return false;
  // Value-bearing actions: same value = a genuine loop; different value =
  // legitimate re-use of the field (re-search, re-entering data).
  if (action.type === 'TYPE' || action.type === 'SELECT') {
    return String(last.value ?? '') === String(action.value ?? '');
  }
  return true;
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

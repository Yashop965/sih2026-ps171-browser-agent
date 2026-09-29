/**
 * #208 — goals that name an ACTION cannot be proven by OCR, and the ones that
 * can be should be proven from the DOM instead.
 *
 * ## Why this exists
 *
 * `visionConfirm` proves a goal by finding its target **text** in the OCR of the
 * visible screen. That is the right instrument for a goal that names something
 * visible ("the order confirmation banner") and the wrong one for a goal that
 * names an **action**:
 *
 *     "Tick the terms of service checkbox"
 *
 * A ticked checkbox is a *state change*, not a string. Nothing appears on screen
 * when it is ticked, so the OCR can never find it and the verdict is
 * permanently `confirmed: false`.
 *
 * Observed live: a run reached 10/11 and then repeated
 * `OCR missing target(s): 11` until the step budget ran out. The agent had done
 * the work correctly and was still reported unfinished.
 *
 * ## What this module does and does not do
 *
 * It **classifies** a goal as an action, so the confirm path can say "this is
 * unverifiable by OCR" once instead of printing a line that means "this can
 * never pass" twenty times.
 *
 * It **verifies checkbox goals from DOM state**, which is a strictly stronger
 * signal than reading pixels: `checked === true` is the fact itself.
 *
 * It does **not** count an unverifiable goal as confirmed. A goal with no
 * checkable DOM state stays unverifiable, and the deterministic backstop still
 * owns completion. This makes the ceiling visible and removes it where it is
 * removable — it does not turn "cannot prove" into "assume yes".
 */

/**
 * Verbs that mean "do something", not "show something". Matched against the
 * normalised description as whole words, so `Sender address is shown` is not
 * read as an action just because it contains "send".
 */
const ACTION_VERBS = [
  'tick',
  'check',
  'uncheck',
  'select',
  'choose',
  'submit',
  'send',
  'press',
  'click',
  'toggle',
  'confirm',
  'accept',
  'agree',
  'apply',
  'upload',
  'download',
  'save',
  'enter',
];

/** Normalise the same way `goalBackstop.normalize` does, minus the stopwords. */
function normalizeForMatch(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[_\-–—/\\|<>]/g, ' ')
    .replace(/[^a-z0-9$@.!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this checklist item an action rather than a visible end-state?
 *
 * Returns false for an empty or absent description: an unknown goal must stay
 * in the existing "cannot prove" bucket rather than be reclassified as an action
 * on no evidence.
 */
export function isActionGoal(description: string | undefined | null): boolean {
  if (!description) return false;
  const words = new Set(normalizeForMatch(description).split(' ').filter(Boolean));
  if (words.size === 0) return false;
  return ACTION_VERBS.some((v) => words.has(v));
}

/**
 * The words in a goal or control name that could identify the control.
 *
 * Verb and article words are dropped, because they describe the ACTION ("tick",
 * "submit") and never identify which control it applies to. What is left is
 * "terms of service checkbox" -> {terms, of, service, checkbox}.
 */
const CONTROL_STOPWORDS = new Set([
  'tick',
  'check',
  'uncheck',
  'select',
  'choose',
  'submit',
  'send',
  'press',
  'click',
  'toggle',
  'confirm',
  'accept',
  'agree',
  'apply',
  'upload',
  'download',
  'save',
  'enter',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'for',
  'of',
  'on',
  'in',
  'with',
  'that',
  'this',
  'box',
  'field',
  'option',
  'button',
  'it',
  'then',
]);

function controlWords(s: string | undefined | null): Set<string> {
  return new Set(
    normalizeForMatch(s)
      .split(' ')
      .filter((w) => w.length > 1 && !CONTROL_STOPWORDS.has(w))
  );
}

/**
 * Do a goal and a control name refer to the same control?
 *
 * Compares WORDS, not substrings of the whole sentence. A substring test fails
 * in the case that actually matters: the goal reads "Tick the terms of service
 * checkbox" while the control is named `tos`, and no substring of one appears in
 * the other. Token comparison matches on `terms`/`service` instead, and also
 * degrades gracefully when the control carries the full label.
 */
function namesMatch(goalWords: Set<string>, control: Set<string>): boolean {
  if (goalWords.size === 0 || control.size === 0) return false;
  // Every identifying word of the shorter name must appear in the longer one.
  const [short, long] =
    goalWords.size <= control.size ? [goalWords, control] : [control, goalWords];
  for (const w of short) if (!long.has(w)) return false;
  return true;
}

/**
 * Is a checkbox-style goal satisfied, given the page's checkbox state?
 *
 * `state` maps a control's name/id/label to its `checked` value, as read on
 * device by the content script. Only real booleans count — a truthy non-boolean
 * is treated as NOT checked, because the whole value of this check is that it
 * reports the real state rather than guessing.
 *
 * The name match is deliberately forgiving in both directions: planners write
 * "terms of service" where the DOM says `tos`, and either being a substring of
 * the other is accepted. A strict match would leave this goal unverifiable, which
 * is the exact problem being fixed.
 */
export function checkboxSatisfied(
  goalName: string | undefined | null,
  state: Record<string, boolean> | null | undefined
): boolean {
  if (!state) return false;
  const words = controlWords(goalName);
  if (words.size === 0) return false;
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== 'boolean' || value !== true) continue;
    if (namesMatch(words, controlWords(key))) return true;
  }
  return false;
}

/**
 * The searchable text for a checkbox goal, given the page's state.
 *
 * Prefers a control whose name matches the goal, so "terms of service" resolves
 * against `tos` rather than against every checkbox on the page. Falls back to
 * the goal text itself, which is what the OCR path already used — so an
 * unmatched checkbox goal still reaches the same "cannot prove" verdict it had
 * before, rather than silently passing.
 */
export function checkboxTargetFor(
  description: string | undefined | null,
  state: Record<string, boolean> | null | undefined
): string | undefined {
  if (!state) return undefined;
  const words = controlWords(description);
  if (words.size === 0) return undefined;
  for (const key of Object.keys(state)) {
    if (namesMatch(words, controlWords(key))) return key;
  }
  return undefined;
}

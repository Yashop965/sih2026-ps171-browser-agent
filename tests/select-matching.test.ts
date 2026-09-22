// tests/select-matching.test.ts — NPTEL-style tolerant <select> option matching.
//
// The live agent kept throwing `no option matching "<value>"` when the planner
// phrased a target loosely (case drift, punctuation, a short unique fragment),
// then re-typed the same value in a loop. matchSelectOption normalises and
// matches exact -> unique-fragment, preferring the most specific option. Also
// verifies the PII-safe error path (audit M3): the requested value never
// echoes into the thrown error string.
import { describe, it, expect, afterEach } from 'vitest';
import { matchSelectOption } from '../src/lib/actions';

function makeSelect(pairs: Array<[string, string]>): HTMLSelectElement {
  const el = document.createElement('select');
  for (const [value, text] of pairs) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    el.appendChild(opt);
  }
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  // Clean up the <select> nodes we appended to keep jsdom tidy between tests.
  document.querySelectorAll('select[data-test]').forEach((n) => n.remove());
});

describe('matchSelectOption (tolerant, NPTEL-style)', () => {
  it('matches an exact option value or label', () => {
    const el = makeSelect([['1', 'World Wide Web'], ['2', 'Hypertext']]);
    // Label match:
    expect(matchSelectOption(el, 'Hypertext')?.value).toBe('2');
    expect(matchSelectOption(el, 'hYPERTEXT')?.value).toBe('2');
    // Value match:
    expect(matchSelectOption(el, '1')?.text).toBe('World Wide Web');
  });

  it('tolerates case + punctuation drift', () => {
    const el = makeSelect([['a', 'Place (Desha)'], ['b', 'Time / Kala'], ['c', 'Person - Patra']]);
    // "Time / Kala" vs a requested "TIME/KALA" (slash spacing differs) -> same.
    expect(matchSelectOption(el, 'TIME/KALA')?.value).toBe('b');
    // "Place (Desha)" with the parens normalised away.
    expect(matchSelectOption(el, 'place desha')?.value).toBe('a');
    // "Person - Patra" (dash) vs "person patra".
    expect(matchSelectOption(el, 'person patra')?.value).toBe('c');
  });

  it('matches by a short unique fragment (the planner\'s loose phrasing)', () => {
    const el = makeSelect([
      ['1', 'Karma Yoga'],
      ['2', 'Vāṅmayī Tapaḥ'],
      ['3', 'Dharma, Karma, and Seva'],
    ]);
    // "seva" is a word unique to option 3 -> resolves it even though the full
    // label has other words around it.
    expect(matchSelectOption(el, 'seva')?.value).toBe('3');
    // A requested value that equals a full label still exact-matches.
    expect(matchSelectOption(el, 'Dharma, Karma, and Seva')?.value).toBe('3');
    expect(matchSelectOption(el, 'Karma Yoga')?.value).toBe('1');
  });

  it('prefers the most specific (shortest label) option when several contain the fragment', () => {
    const el = makeSelect([
      ['wide', 'World Wide Web'],
      ['web', 'World'],
      ['net', 'World Wide Web Consortium'],
    ]);
    // Request "World" resolves to the option literally labelled "World",
    // not the longer "World Wide Web" that also contains it.
    expect(matchSelectOption(el, 'world')?.value).toBe('web');
  });

  it('returns undefined when nothing matches', () => {
    const el = makeSelect([['1', 'Alpha'], ['2', 'Beta']]);
    expect(matchSelectOption(el, 'Gamma')).toBeUndefined();
    expect(matchSelectOption(el, '')).toBeUndefined();
    expect(matchSelectOption(el, '   ')).toBeUndefined();
  });

  it('does not match a 1-char option label as a fragment (avoids "in"/"a" collisions)', () => {
    const el = makeSelect([['1', 'A'], ['2', 'Actual target']]);
    // "a" alone is too ambiguous a fragment; the full word must match.
    expect(matchSelectOption(el, 'actual target')?.value).toBe('2');
    // A bare "a" must NOT resolve to the single-char "A" option via fragment.
    expect(matchSelectOption(el, 'a')?.value).toBe('1'); // exact, not fragment
  });
});

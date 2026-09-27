/**
 * #204 — the Florence-2 result unwrapping.
 *
 * Once the model finally loaded, every task still returned nothing. The model
 * had been producing correct output the whole time; the pipeline threw it away.
 *
 * `post_process_generation` returns the TASK TOKEN as the top-level key:
 *
 *   { '<OCR>': 'WIKIPEDIAQ BDonate Create account Log in...' }
 *
 * captured live from a real Wikipedia screenshot (`keys: ['<OCR>']`). The old
 * `extractText` only ever read `result.text` and `result.words` — neither of
 * which exists on that shape — so every OCR came back empty and the worker
 * reported "empty ocr" on a perfectly good reading.
 *
 * These use the literal captured shapes, not invented ones, and call the real
 * exported functions. The nested variant is covered too, because a different
 * transformers.js build nests the payload and both must work.
 */

import { describe, it, expect } from 'vitest';
import { extractText, extractBoxes } from '../src/lib/vision/florence2';

/** The real captured OCR value from a live Wikipedia screenshot. */
const REAL_OCR_TEXT =
  'WIKIPEDIAQ BDonate Create account Log in25 years of the free empliabiaISRO7 ' +
  'language article talkReadEdit View historyFrom Wikipedia, the free free ' +
  "woodpeopediaCoordinates130'0'07 77'4\"EThe Indian Space Research " +
  'organization (ISRO) /ISRO /ISR) /isRO /isro /isR) is the national space ' +
  'agencyindian Space Researchof India';

describe('#204 extractText unwraps the Florence-2 task-token shape', () => {
  it('reads text from the captured real OCR result', () => {
    // The exact object the live model produced. It used to return undefined
    // here, which surfaced to the user as "empty ocr".
    expect(extractText({ '<OCR>': REAL_OCR_TEXT }, 'ocr')).toBe(REAL_OCR_TEXT);
  });

  it('reads caption output from the same shape', () => {
    expect(extractText({ '<CAP>': 'cannot tell' }, 'caption')).toBe('cannot tell');
  });

  it('reads question-answering output', () => {
    expect(extractText({ '<VQA>': 'a blue banner' }, 'question-answering')).toBe('a blue banner');
  });

  it('reads a nested payload, for builds that nest it', () => {
    expect(extractText({ '<OCR>': { text: 'nested form' } }, 'ocr')).toBe('nested form');
  });

  it('prefers the token value over an unrelated sibling key', () => {
    expect(extractText({ other: 'ignored', '<OCR>': 'the real text' }, 'ocr')).toBe(
      'the real text'
    );
  });

  it('ignores a non-token key that merely looks similar', () => {
    expect(extractText({ texty: 'nope' }, 'ocr')).toBeUndefined();
  });

  it('does not return an empty string as a reading', () => {
    // An empty/whitespace token must fall through, so the caller still sees a
    // genuine miss rather than a fake success.
    expect(extractText({ '<OCR>': '   ' }, 'ocr')).toBeUndefined();
  });
});

describe('#204 extractText still honours the pre-existing shapes', () => {
  it('keeps reading result.text', () => {
    expect(extractText({ text: 'legacy shape' }, 'ocr')).toBe('legacy shape');
  });

  it('keeps joining result.words', () => {
    expect(extractText({ words: [{ word: 'a' }, { word: 'b' }] }, 'ocr')).toBe('a b');
  });

  it('keeps reading generated_text for captions', () => {
    expect(extractText({ generated_text: 'legacy cap' }, 'caption')).toBe('legacy cap');
  });

  it('keeps reading answer for question-answering', () => {
    expect(extractText({ answer: 'legacy answer' }, 'question-answering')).toBe('legacy answer');
  });

  it('returns undefined for an empty result', () => {
    expect(extractText(null, 'ocr')).toBeUndefined();
  });
});

describe('#204 extractBoxes unwraps the grounding task token', () => {
  it('finds bboxes nested under <PG>', () => {
    const boxes = extractBoxes(
      { '<PG>': { bboxes: [[10, 20, 110, 80]], labels: ['search box'] } },
      'grounding'
    );
    expect(boxes).toHaveLength(1);
    expect(boxes?.[0]).toMatchObject({ x: 10, y: 20, width: 100, height: 60 });
  });

  it('finds bboxes nested under <OD>', () => {
    const boxes = extractBoxes({ '<OD>': { bboxes: [[1, 2, 3, 4]] } }, 'object-detection');
    expect(boxes).toHaveLength(1);
  });

  it('keeps reading a top-level bboxes container', () => {
    const boxes = extractBoxes({ bboxes: [[1, 2, 3, 4]] }, 'grounding');
    expect(boxes).toHaveLength(1);
  });

  it('does not throw when the token holds only text', () => {
    expect(() => extractBoxes({ '<OCR>': REAL_OCR_TEXT }, 'ocr')).not.toThrow();
  });

  it('returns undefined for a text-only token rather than fake boxes', () => {
    expect(extractBoxes({ '<OCR>': REAL_OCR_TEXT }, 'ocr')).toBeUndefined();
  });
});

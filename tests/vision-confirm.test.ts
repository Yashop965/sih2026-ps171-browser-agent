// tests/vision-confirm.test.ts — issue #100 optional on-device OCR confirm
import { describe, it, expect } from 'vitest';
import { visionConfirm, itemTargets, targetInOcr } from '../src/lib/visionConfirm';

const OCR = 'Wikipedia. Learn more. Progressive web app. 24 language options. Contents articles. A progressive web application (PWA) is a type of web app that can work offline.';

describe('itemTargets', () => {
  it('prefers a quoted span', () => {
    expect(itemTargets({ id: '1', description: "open 'Progressive web app' article" })).toEqual(['Progressive web app']);
  });
  it('falls back to content tokens when no quotes', () => {
    const t = itemTargets({ id: '2', description: 'open the web browser article' });
    expect(t.length).toBe(1);
    expect(t[0]).toContain('web');
    expect(t[0]).toContain('browser');
  });
  it('returns [] for a stopword-only description', () => {
    expect(itemTargets({ id: '3', description: 'open the page' })).toEqual([]);
  });
});

describe('targetInOcr', () => {
  it('matches a quoted phrase present in the OCR', () => {
    expect(targetInOcr('"Progressive web app"', OCR)).toBe(true);
  });
  it('does not match a phrase absent from the OCR', () => {
    expect(targetInOcr('"Quantum physics"', OCR)).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(targetInOcr('"progressive WEB app"', OCR)).toBe(true);
  });
});

describe('visionConfirm', () => {
  it('confirms when every open goal is in the OCR', () => {
    const v = visionConfirm(OCR, [
      { id: '1', description: "open 'Progressive web app' article" },
      { id: '2', description: "read 'progressive web application'" }, // exact phrase IS in the OCR
    ]);
    expect(v.confirmed).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it('does NOT confirm when one goal is missing', () => {
    const v = visionConfirm(OCR, [
      { id: '1', description: "open 'Progressive web app' article" },
      { id: '9', description: "open 'Quantum physics' article" },
    ]);
    expect(v.confirmed).toBe(false);
    expect(v.missing).toContain('9');
  });

  it('does NOT confirm a goal with no usable target (no-signal)', () => {
    const v = visionConfirm(OCR, [{ id: '1', description: 'open the page' }]);
    expect(v.confirmed).toBe(false);
    expect(v.missing).toContain('1');
  });

  it('returns confirmed:false for an empty open list', () => {
    const v = visionConfirm(OCR, []);
    expect(v.confirmed).toBe(false);
  });

  it('reports a human-readable detail', () => {
    const v = visionConfirm(OCR, [{ id: '1', description: "open 'Progressive web app' article" }]);
    expect(v.detail).toMatch(/all 1 open goal/i);
  });
});

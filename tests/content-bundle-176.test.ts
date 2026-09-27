/**
 * #176 — the in-content Florence-2 pipeline was dead weight.
 *
 * The content script imported `visionPipeline` as a VALUE. That single import
 * pulled ~904 KB of @huggingface/transformers into content.js — a file parsed
 * on EVERY page load — even though nothing ever called it.
 *
 * These tests pin the finding rather than the code's behaviour: the point is
 * that the absence is load-bearing. Re-adding the import must fail here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const content = readFileSync('src/entrypoints/content.ts', 'utf-8');
const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');

describe('the content script does not pull in the VLM', () => {
  it('never imports florence2 as a value', () => {
    // A type-only import is free; a value import is what cost 904 KB. Assert
    // the absence of the IMPORT, not the substring: the file's own comment
    // explains why the import is gone, and must keep naming the module.
    expect(content).not.toMatch(/^\s*import\s+.*from\s+'[^']*florence2'/m);
    expect(content).not.toMatch(/visionPipeline/);
  });

  it('keeps no VISION_* handler that would need it', () => {
    for (const t of ['VISION_EXTRACT', 'VISION_OCR', 'VISION_STATUS']) {
      expect(content, `${t} handler is back`).not.toContain(`message.type === '${t}'`);
    }
  });

  it('rejects the removed types at the request guard', () => {
    // Found in review: the handlers were gone but isAgentRequest still
    // returned true for these types, so a stale sender would be ACCEPTED and
    // then fall through to a bare `return` - answering `undefined`, which a
    // caller cannot distinguish from a lost message. The union and the guard
    // have to agree with the handlers.
    const guard = content.slice(content.indexOf('function isAgentRequest'));
    for (const t of ['VISION_EXTRACT', 'VISION_OCR', 'VISION_STATUS']) {
      expect(guard, `${t} still passes the guard`).not.toContain(`'${t}'`);
    }
  });

  it('still accepts VISION_GROUND, which the offscreen host really sends', () => {
    // The one VISION_* type that is live. The grounding fallback sends it on
    // every near-empty-DOM page, so removing it would be a real regression.
    expect(content).toContain("message.type === 'VISION_GROUND'");
  });

  it('keeps no removed helper', () => {
    for (const fn of [
      'extractWithVision',
      'ocrVisibleScreen',
      'mergeVisionWithDOM',
      'getVisionStatus',
    ]) {
      expect(content, `${fn} is back`).not.toContain(fn);
    }
  });
});

describe('the offscreen host is still the live path', () => {
  // The point of the deletion is that this is where vision actually happens.
  // If the host ever went away, content.js would be small AND broken - so
  // these are the guard that makes the small bundle honest.
  it('routes OCR, grounding and status through vlmHost', () => {
    expect(bg).toMatch(/import \{[^}]*vlmHostOcr[^}]*\} from '\.\.\/lib\/vlmHost'/);
    expect(bg).toContain('vlmHostGround(');
    expect(bg).toContain('vlmHostStatus()');
  });

  it('keeps florence2 for the worker that actually runs the model', () => {
    // Deleting florence2.ts would be a feature regression, not a cleanup.
    const worker = readFileSync('src/entrypoints/vlm-host-worker.ts', 'utf-8');
    expect(worker).toMatch(/import \{ visionPipeline \}/);
  });

  it('keeps the VISION_EXTRACT message type in the SW request union', () => {
    // The SW still declares and forwards it. Removing the content-side handler
    // makes that forward a no-op rather than an error - a deliberate choice,
    // recorded here so nobody removes the union entry and changes the shape of
    // what the SW accepts.
    expect(bg).toContain("| { type: 'VISION_EXTRACT' }");
  });
});

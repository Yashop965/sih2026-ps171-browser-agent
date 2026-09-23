/**
 * #136/D: VLM live-indicator truthfulness.
 *
 * The popup's VLM pill used to read "idle · loads on first vision check"
 * forever even after a failed model load, because initialize() cleared its
 * load promise on error and status() had no 'failed' state. These tests pin
 * the new behaviour on the shared singleton:
 *
 *   1. before any attempt: honest 'idle'
 *   2. a failed model load is reported as state === 'failed' with the reason
 *   3. re-initializing inside the retry cooldown fast-fails with that reason
 *      instead of re-triggering the ~150MB download
 *   4. a successful (re-)load clears the recorded failure -> state 'ready'
 *
 * The heavy model loader is mocked so no download happens in the test.
 */
import { describe, it, expect, vi } from 'vitest';

// vi.mock factories are hoisted above ordinary declarations, so the mock
// functions live in a vi.hoisted() scope.
const { modelLoad, procLoad } = vi.hoisted(() => ({
  modelLoad: vi.fn(),
  procLoad: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: false, useBrowserCache: true, logLevel: 'error' },
  Florence2ForConditionalGeneration: { from_pretrained: modelLoad },
  AutoProcessor: { from_pretrained: procLoad },
}));

import { visionPipeline } from '../src/lib/vision/florence2';

const FAIL_MSG = '401 model not found (offline test Chrome)';

// Private field access (the class keeps its state private by design).
const pipeline = visionPipeline as any;

describe('VisionStatus (florence2 singleton)', () => {
  it('reports idle before any load attempt (jsdom, no WebGPU)', () => {
    // No failure recorded yet, so the honest "not started" state is idle.
    const s = visionPipeline.status();
    expect(s.state).toBe('idle');
    expect(s.lastLoadError).toBeUndefined();
  });

  it('reports state=failed with the reason after a failed load', async () => {
    modelLoad.mockRejectedValue(new Error(FAIL_MSG));
    await expect(visionPipeline.initialize()).rejects.toThrow(FAIL_MSG);

    const s = visionPipeline.status();
    expect(s.state).toBe('failed');
    expect(s.lastLoadError).toContain(FAIL_MSG);
    expect(typeof s.loadFailedAt).toBe('number');
  });

  it('fast-fails inside the cooldown instead of re-downloading', async () => {
    // A load just failed moments ago -> still inside the 60s cooldown, so
    // initialize() must reject with the stored reason without calling the
    // real loader again.
    const callsBefore = modelLoad.mock.calls.length;
    await expect(visionPipeline.initialize()).rejects.toThrow(/retrying in/i);
    expect(modelLoad.mock.calls.length).toBe(callsBefore); // no re-download
  });

  it('clears the recorded failure after a successful (re-)load', async () => {
    // Reset the cooldown + recorded failure so the next load actually runs.
    pipeline.lastLoadError = '';
    pipeline.loadFailedAt = 0;

    modelLoad.mockResolvedValue({ ok: 'model' });
    procLoad.mockResolvedValue({ ok: 'processor' });
    await visionPipeline.initialize();

    const s = visionPipeline.status();
    expect(s.state).toBe('ready');
    expect(pipeline.lastLoadError).toBe('');
    expect(pipeline.loadFailedAt).toBe(0);
  });
});

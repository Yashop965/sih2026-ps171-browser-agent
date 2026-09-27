/**
 * #204 — the VLM must load onnxruntime from the extension, not the jsdelivr CDN.
 *
 * The failure was silent and total: every model load ended with
 *
 *   no available backend found. ERR: [webgpu] TypeError: Failed to fetch
 *   dynamically imported module:
 *   https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/
 *   ort-wasm-simd-threaded.jsep.mjs
 *
 * which is a **privacy** failure as much as a functional one: the project
 * claims on-device inference, and a third-party CDN request contradicts that
 * even when the request fails.
 *
 * Root cause: the #141 override resolved the ORT base URL with
 * `chrome.runtime.getURL`, but the code that actually runs the pipeline is
 * `vlm-host-worker.js` — a dedicated module Worker, where `chrome` does not
 * exist. Probed live inside that worker:
 *
 *   { inWorker: true, hasChromeObj: false, hasRuntime: false, hasGetURL: false }
 *
 * So `baseUrl` was `undefined`, the whole `if (baseUrl)` block was skipped
 * without error, and transformers.js kept its CDN default.
 *
 * These tests pin the resolver against the contexts it must handle, including
 * the worker shape that caused the bug.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extensionAssetBaseUrl } from '../src/lib/vision/florence2';

const REAL_ID = 'npflaobdhllbgleohljinimffoolfpng';
const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Set<string>();

function setGlobal(key: string, value: unknown): void {
  saved.add(key);
  globals[key] = value;
}

afterEach(() => {
  for (const k of saved) delete globals[k];
  saved.clear();
});

describe('#204 extensionAssetBaseUrl resolves inside a module Worker (the #204 context)', () => {
  it('works with NO chrome global at all - the exact failing shape', () => {
    // A dedicated module Worker: `chrome` undefined, `browser` undefined, but
    // its own script URL is a chrome-extension:// origin. This is the case the
    // old implementation returned undefined for.
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', { origin: `chrome-extension://${REAL_ID}`, href: '' });

    expect(extensionAssetBaseUrl('vlm/ort/')).toBe(`chrome-extension://${REAL_ID}/vlm/ort/`);
  });

  it('never returns undefined while the origin is an extension origin', () => {
    // The bug's real shape was a SILENT skip, not a crash. This is the direct
    // guard against it: no chrome API, yet a usable URL.
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', { origin: `chrome-extension://${REAL_ID}`, href: '' });
    expect(extensionAssetBaseUrl('vlm/ort/')).toBeTruthy();
  });

  it('does not use a CDN url under any extension context', () => {
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', { origin: `moz-extension://abc-123`, href: '' });
    const out = extensionAssetBaseUrl('vlm/ort/') ?? '';
    expect(out).not.toMatch(/https?:\/\/(?!moz-extension)/);
    expect(out.startsWith('moz-extension://')).toBe(true);
  });
});

describe('#204 prefers chrome.runtime.getURL when it IS available', () => {
  it('uses the API in a page/service-worker context', () => {
    setGlobal('chrome', {
      runtime: { getURL: (p: string) => `chrome-extension://${REAL_ID}/${p}` },
    });
    setGlobal('location', { origin: 'https://example.com', href: '' });
    expect(extensionAssetBaseUrl('vlm/ort/')).toBe(`chrome-extension://${REAL_ID}/vlm/ort/`);
  });

  it('prefers the API over the origin fallback when both exist', () => {
    setGlobal('chrome', {
      runtime: { getURL: () => `chrome-extension://${REAL_ID}/FROM_API/` },
    });
    setGlobal('location', { origin: `chrome-extension://${REAL_ID}`, href: '' });
    expect(extensionAssetBaseUrl('vlm/ort/')).toContain('FROM_API');
  });
});

describe('#204 refuses to invent a URL outside an extension context', () => {
  it('returns undefined on a plain web page', () => {
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', { origin: 'https://example.com', href: '' });
    expect(extensionAssetBaseUrl('vlm/ort/')).toBeUndefined();
  });

  it('returns undefined with no location at all', () => {
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', undefined);
    expect(extensionAssetBaseUrl('vlm/ort/')).toBeUndefined();
  });

  it('does not throw when getURL itself throws', () => {
    setGlobal('chrome', {
      runtime: {
        getURL: () => {
          throw new Error('nope');
        },
      },
    });
    setGlobal('location', { origin: 'https://example.com', href: '' });
    expect(() => extensionAssetBaseUrl('vlm/ort/')).not.toThrow();
  });
});

describe('#204 path handling', () => {
  it('normalises a leading slash so callers cannot double it', () => {
    setGlobal('chrome', {
      runtime: { getURL: (p: string) => `chrome-extension://${REAL_ID}/${p}` },
    });
    setGlobal('location', { origin: 'https://example.com', href: '' });
    expect(extensionAssetBaseUrl('/vlm/ort/')).toBe(extensionAssetBaseUrl('vlm/ort/'));
  });

  it('strips a trailing slash from the origin', () => {
    setGlobal('chrome', undefined);
    setGlobal('browser', undefined);
    setGlobal('location', { origin: `chrome-extension://${REAL_ID}/`, href: '' });
    expect(extensionAssetBaseUrl('vlm/ort/')).not.toContain('//vlm');
  });
});

describe('#204 the loader sets wasmPaths from the resolver, with no silent skip', () => {
  const src = readFileSync('src/lib/vision/florence2.ts', 'utf-8');

  it('assigns wasmPaths through extensionAssetBaseUrl', () => {
    // The regression guard: if someone reintroduces the `g.browser ?? g.chrome`
    // lookup inline, the worker path silently breaks again.
    expect(src).toMatch(/extensionAssetBaseUrl\('vlm\/ort\/'\)/);
    expect(src).toMatch(/ortWasm\.wasmPaths\s*=/);
  });

  it('no longer derives the ORT base URL from a chrome global', () => {
    // `g.browser ?? g.chrome` inline in the loader is the exact defect.
    const loader = src.slice(src.indexOf('wasmPaths'), src.indexOf('from_pretrained'));
    expect(loader).not.toMatch(/g\.browser\s*\?\?\s*g\.chrome/);
  });

  it('does not silently swallow a missing base URL in the loader', () => {
    // There is no try/catch around the wasmPaths block any more: a failure to
    // resolve must be visible, not a no-op that restores the CDN default.
    const start = src.indexOf('const baseUrl = extensionAssetBaseUrl');
    const end = src.indexOf('from_pretrained', start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/\}\s*catch\s*\{/);
  });
});

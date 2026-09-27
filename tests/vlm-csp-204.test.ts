/**
 * #204 — the extension_pages CSP must allow WASM, and only that much.
 *
 * The VLM was broken in two independent places, both silent:
 *
 *   1. `florence2.ts` resolved the ORT base URL with `chrome.runtime.getURL`,
 *      which does not exist in the dedicated module Worker that runs the
 *      pipeline -> transformers.js kept its jsdelivr CDN default.
 *   2. The manifest declared NO `content_security_policy`, so MV3's default
 *      `script-src 'self'` applied and forbade WebAssembly compilation
 *      outright.
 *
 * Fixing only (1) moved the failure to (2), live:
 *   WebAssembly.instantiate(): ... violates ... "script-src 'self'"
 *
 * These tests pin the CSP's *narrowness*. `'wasm-unsafe-eval'` is a real
 * loosening of the default, and the only thing keeping it defensible is that
 * nothing else was loosened with it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = readFileSync('wxt.config.ts', 'utf-8');
const manifest = readFileSync('dist/chrome-mv3/manifest.json', 'utf-8');

const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

describe('#204 the extension pages CSP permits WebAssembly compilation', () => {
  it('is declared in wxt.config.ts', () => {
    expect(config).toMatch(/content_security_policy\s*:/);
  });

  it('lands in the BUILT manifest, not just the source config', () => {
    // The config is easy to get right and the build easy to get wrong; only
    // the built artifact is what Chrome actually enforces.
    const m = JSON.parse(manifest) as {
      content_security_policy?: Record<string, string>;
    };
    expect(m.content_security_policy?.extension_pages).toBe(CSP);
  });

  it('allows wasm compilation', () => {
    expect(config).toMatch(/'wasm-unsafe-eval'/);
  });
});

describe('#204 the CSP loosening stays as narrow as the feature requires', () => {
  it('does NOT allow unsafe-eval', () => {
    // The whole point of 'wasm-unsafe-eval' over 'unsafe-eval': it permits
    // compiling WASM and nothing else. `eval()` and `new Function()` must stay
    // blocked, so this source must never appear.
    expect(config).not.toMatch(/script-src[^'"]*'unsafe-eval'/);
    expect(manifest).not.toMatch(/script-src[^'"]*'unsafe-eval'/);
  });

  it('does NOT add any remote origin', () => {
    // An https: source in script-src would let a compromised CDN inject code
    // into the extension. The whole point of #141/#204 is same-origin assets.
    expect(config).not.toMatch(/script-src[^;]*https?:/);
    expect(manifest).not.toMatch(/script-src[^;]*https?:/);
  });

  it('does NOT add blob:, data: or wildcard sources', () => {
    for (const src of ['blob:', 'data:', '*']) {
      expect(config, `source ${src} was added`).not.toMatch(
        new RegExp(`script-src[^;]*'${src.replace('*', '\\*')}'`)
      );
    }
  });

  it('keeps script-src restricted to self', () => {
    expect(CSP).toContain("script-src 'self'");
  });

  it('keeps object-src at the MV3 default', () => {
    expect(CSP).toContain("object-src 'self'");
  });

  it('scopes the CSP to extension_pages only', () => {
    // A `sandbox` or bare-string CSP would also apply to other surfaces.
    // extension_pages is the narrowest scope that covers the offscreen
    // document and the VLM worker.
    const m = JSON.parse(manifest) as {
      content_security_policy?: Record<string, string>;
    };
    expect(Object.keys(m.content_security_policy ?? {})).toEqual(['extension_pages']);
  });
});

describe('#204 the #151 no-web-accessible-resources decision is untouched', () => {
  it('still ships no web_accessible_resources', () => {
    // The .wasm is fetched same-origin by the extension itself. Loosening the
    // CSP must not come with reopening the 21MB runtime to every web page.
    const m = JSON.parse(manifest) as { web_accessible_resources?: unknown[] };
    expect(m.web_accessible_resources).toEqual([]);
  });
});

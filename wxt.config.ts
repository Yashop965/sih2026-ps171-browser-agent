import { defineConfig } from 'wxt';

export default defineConfig({
  name: 'SIH2026 PS171 Browser Agent',
  description: 'On-device Visual Perception for Light-weight Browser Agents',
  manifest: {
    version: '1.0.0',
    permissions: [
      'activeTab',
      'tabs',
      'storage',
      'scripting',
      'alarms',
      // #142: the offscreen document that owns the dedicated module worker
      // hosting the on-device VLM (Florence-2). The worker + ORT runtime
      // live there because neither the SW scope (no new Worker) nor the
      // content-script isolated world (no import() of module URLs) can.
      'offscreen',
    ],
    // #151: NO web_accessible_resources. The onnxruntime-web loader + jsep
    // .wasm (public/vlm/ort/, copied to the dist root by WXT) are fetched
    // ONLY by the offscreen module worker via runtime.getURL('vlm/ort/') — an
    // EXTENSION-ORIGIN fetch, which the extension may always access WITHOUT a
    // WAR (WARs only expose resources to *web / other-extension* origins). The
    // original #141 WAR ({ resources: ['vlm/ort/*'], matches:
    // ['*://*/*','file://*'] }) exposed the 21MB ORT runtime + wasm to ANY web
    // page — an unnecessary egress surface left over from when ORT ran in the
    // content script. #142 moved ORT to the offscreen worker, so the WAR is
    // vestigial and is removed here (nothing in a web-page context touches
    // vlm/ort/*; the only consumers are the extension-origin worker + relay).
    web_accessible_resources: [],
    host_permissions: [
      'http://localhost:8000/*',
      // #113: captureVisibleTab (on-device VLM screenshots) runs from the
      // service worker on an arbitrary focused web tab, so it needs host
      // access to the captured tab. <all_urls> matches the content-script
      // injection the agent already uses to perceive any page. Adds NO
      // data-egress path: the screenshot stays on-device (OCR'd by
      // Florence-2), and the only network call is still the localhost:8000
      // planner.
      '<all_urls>',
    ],
    // #204: the on-device VLM cannot compile WebAssembly under MV3's default
    // extension_pages CSP. With no `content_security_policy` declared, Chrome
    // applies `script-src 'self'; object-src 'self'`, and that forbids WASM
    // instantiation outright:
    //
    //   WebAssembly.instantiate(): Compiling or instantiating WebAssembly
    //   module violates the following Content Security policy directive
    //   because neither 'wasm-eval' nor 'unsafe-eval' is an allowed source of
    //   script in "script-src 'self'".
    //
    // So every Florence-2 load died at backend init even once the ORT runtime
    // was loading same-origin (#141). This is the other half of that fix, and
    // the reason on-device vision has never worked end to end.
    //
    // Why this is a narrow, deliberate loosening:
    //   - `'wasm-unsafe-eval'` permits COMPILING WebAssembly. It does NOT
    //     permit `eval()` or `new Function()`, which stay blocked. The
    //     'unsafe-eval' source is deliberately absent.
    //   - It is scoped to `extension_pages` only, so the CSP applied to
    //     content scripts and web pages is untouched.
    //   - The .wasm bytes come from the extension's own package
    //     (public/vlm/ort/, same-origin, no web_accessible_resources per #151),
    //     so this does not widen any network egress path.
    //   - It is the minimum required for onnxruntime-web. There is no
    //     alternative source that enables WASM without eval.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  srcDir: 'src',
  outDir: 'dist',
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
    firefoxArgs: [],
  },
  modules: ['@wxt-dev/module-react'],
});

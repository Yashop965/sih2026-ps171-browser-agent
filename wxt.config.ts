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
    // #141: expose the bundled onnxruntime-web loader + jsep .wasm to the
    // content script so transformers.js can `import()` the ORT runtime from
    // the extension's own origin (same-origin = CSP-clean, no jsdelivr).
    // Without this, the content script's dynamic module import of a
    // chrome-extension:// URL is refused -> "Failed to fetch dynamically
    // imported module" -> "no available backend found" and the on-device
    // VLM never loads.
    web_accessible_resources: [
      {
        resources: ['vlm/ort/*'],
        matches: ['*://*/*', 'file://*'],
      },
    ],
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
  },
  srcDir: 'src',
  outDir: 'dist',
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
    firefoxArgs: [],
  },
  modules: ['@wxt-dev/module-react'],
});

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
  },
  srcDir: 'src',
  outDir: 'dist',
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
    firefoxArgs: [],
  },
  modules: ['@wxt-dev/module-react'],
});

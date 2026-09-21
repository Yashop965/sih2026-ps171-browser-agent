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
    ],
    // #113: captureVisibleTab (the on-device VLM path in content.ts / #100)
    // needs host access to the CAPTURED tab. With only localhost:8000/* the
    // capture of a Wikipedia tab throws "Either <all_urls> or activeTab
    // permission is required" -> the VLM short-circuits to 'no screenshot'
    // before the model-load code runs. <all_urls> is consistent with the
    // content_scripts already injected on <all_urls> (how the agent perceives
    // any page) and adds NO new data-egress path: the screenshot is captured
    // into memory and OCR'd on-device by Florence-2 (pixels never leave the
    // machine); the only network call remains the localhost:8000 planner.
    host_permissions: [
      'http://localhost:8000/*',
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

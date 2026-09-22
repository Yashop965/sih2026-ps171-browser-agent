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

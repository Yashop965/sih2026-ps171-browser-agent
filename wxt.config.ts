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
    ],
    host_permissions: [
      'http://localhost:8000/*',
    ],
  },
  srcDir: 'src',
  outDir: 'dist',
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
  },
  modules: ['@wxt-dev/module-react'],
});

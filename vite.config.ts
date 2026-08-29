import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  build: {
    target: 'es2022',
    outDir: '.output/chrome-mv3',
  },
});

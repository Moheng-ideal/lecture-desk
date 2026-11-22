import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/client',
    target: ['chrome104', 'safari16.4'],
    chunkSizeWarningLimit: 1000,
  },
});

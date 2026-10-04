import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { appRegionPlugin } from './scripts/appRegionPlugin';

// Tauri loads this one build; the shell opens each window with a hash route
// (src/main.tsx). Fixed port + strictPort because tauri.conf.json's devUrl
// points at it. Workspace packages are raw TypeScript source, bundled here.
export default defineConfig({
  plugins: [react(), appRegionPlugin()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5175, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { outDir: 'dist', target: 'safari15' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The bridge test reads the renderer's declaration with the TypeScript compiler.
    server: { deps: { external: [/node_modules\/typescript\//] } },
  },
});

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Workspace packages are shipped as raw TypeScript source (no build step), so
// they must be BUNDLED into the Electron bundles, not externalized (`exclude`).
// Native / node deps in `dependencies` (better-sqlite3, etc.) stay external
// automatically.
//
// `get-windows` lives in optionalDependencies (it's a graceful no-op on Linux
// CI), which externalizeDepsPlugin does NOT auto-externalize — so without the
// explicit `include` it gets bundled, and bundling its native binary chain
// drags in node-pre-gyp's phantom `mock-aws-s3` require → runtime load failure
// → meeting detection + active-window capture silently disabled. Forcing it
// external loads the real ESM module + its Swift binary from node_modules at
// runtime (in dev AND in the packaged app).
const bundleWorkspace = { exclude: ['@grind/core', '@grind/types'], include: ['get-windows'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts'), formats: ['cjs'] },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'] },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard SPA. In dev, /v1 is proxied through the Vite origin so the
// httpOnly grind_at cookie stays first-party. Deploys with a separate API
// host can still set VITE_API_BASE.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

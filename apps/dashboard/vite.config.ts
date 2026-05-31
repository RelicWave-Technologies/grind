import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard SPA. Dev runs on :5174; talks to the API at :3000.
// We use cookie auth (grind_at, httpOnly), so every fetch ships
// `credentials: 'include'` — the API responds with CORS
// credentials:true so the cookie crosses origins in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

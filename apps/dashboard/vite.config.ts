import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard SPA. In dev, /v1 is proxied through the Vite origin so the
// httpOnly grind_at cookie stays first-party. Deploys with a separate API
// host can still set VITE_API_BASE.
//
// `vite --mode mock` (the `dev:mock` script) runs the SPA against dummy data
// instead: src/mock answers every /v1 fetch in the browser, and the plugin
// below answers the few /v1 *navigations* (Lark sign-in, downloads) so nothing
// reaches the :4000 proxy — which is not configured in mock mode at all.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock' || process.env.VITE_MOCK === '1';
  return {
    plugins: mock ? [react(), timoMockNavigations()] : [react()],
    // A build-time constant, so `if (import.meta.env.VITE_MOCK === '1')` in
    // main.tsx folds away and a normal build carries no mock code.
    define: { 'import.meta.env.VITE_MOCK': JSON.stringify(mock ? '1' : '') },
    server: {
      port: 5174,
      strictPort: true,
      proxy: mock
        ? undefined
        : {
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
  };
});

/** Mock mode only: top-level /v1 navigations that a fetch patch cannot see. */
function timoMockNavigations(): Plugin {
  return {
    name: 'timo-mock-navigations',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? '';
        if (!raw.startsWith('/v1/')) return next();
        const url = new URL(raw, 'http://localhost');
        const path = url.pathname;

        // Lark OAuth start → straight back into the app, signed in.
        if (path === '/v1/auth/lark/start') {
          const nextParam = url.searchParams.get('next');
          const target = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/home';
          res.statusCode = 302;
          res.setHeader('Location', `${target}${target.includes('?') ? '&' : '?'}mock_signin=1`);
          res.end();
          return;
        }

        if (path.startsWith('/v1/downloads/agent/')) {
          const platform = path.split('/').pop() || 'agent';
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="Timo-${platform}-mock.txt"`);
          res.end(`Timo desktop agent (${platform}) — mock download. The real installer is served by the API.\n`);
          return;
        }

        if (path.endsWith('.csv')) {
          const name = path.split('/').pop() || 'export.csv';
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          res.end('note\n"Mock mode: open this download from the dashboard to get a file built from the mock data."\n');
          return;
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_mocked', hint: 'In mock mode /v1 is answered in the browser (src/mock); this path was requested as a page navigation.', path }));
      });
    },
  };
}

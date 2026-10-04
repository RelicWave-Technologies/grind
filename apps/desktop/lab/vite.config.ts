/**
 * Agent Lab — the desktop renderer in a plain browser, against a fake
 * `window.agent` bridge, every window at its real size (no Tauri needed).
 * `pnpm lab` (= `pnpm --filter @grind/desktop lab`).
 *
 *   /lab/               gallery: every surface side by side + scenario controls
 *   /lab/surface.html   one surface (same hash routing as Electron)
 *
 * Dev-only. The app build has a single input (index.html) and never sees this
 * folder.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import { appRegionPlugin } from '../scripts/appRegionPlugin';

const labDir = fileURLToPath(new URL('.', import.meta.url));
const appDir = resolve(labDir, '..');
const repoRoot = resolve(appDir, '../..');
const rendererHtml = normalizePath(resolve(appDir, 'index.html'));
const surfaceHtml = normalizePath(resolve(labDir, 'surface.html'));

/** Point relative src/href values at `base` (a URL path ending in '/'). */
function rebase(html: string, base: string): string {
  return html.replace(/\s(src|href)="([^"]+)"/g, (match: string, attr: string, value: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)) return match;
    return ` ${attr}="${new URL(value, `http://lab${base}`).pathname}"`;
  });
}

/**
 * Serves /lab/surface.html as the renderer's own index.html plus the lab's
 * entry script, inserted ahead of the first renderer script. Keeping the real
 * page (CSP meta, stylesheet link, #root) means the lab can't drift from what
 * Electron loads when the restyle touches index.html.
 */
function rendererPage(): Plugin {
  return {
    name: 'agent-lab:renderer-page',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (normalizePath(ctx.filename) !== surfaceHtml) return html;
        const labScripts = rebase(html, '/lab/').match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
        const page = rebase(readFileSync(rendererHtml, 'utf8'), '/');
        const inject = `${labScripts.join('\n    ')}\n    `;
        const at = page.search(/<script\b/i);
        return at >= 0 ? page.slice(0, at) + inject + page.slice(at) : page.replace(/<\/body>/i, `${inject}</body>`);
      },
    },
    handleHotUpdate({ file, server }) {
      // Not in the module graph, so Vite would only reload a page AT that path.
      if (normalizePath(file) === rendererHtml) server.ws.send({ type: 'full-reload', path: '*' });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/') return next();
        res.statusCode = 302;
        res.setHeader('Location', '/lab/');
        res.end();
      });
    },
  };
}

export default defineConfig({
  root: appDir,
  appType: 'mpa',
  clearScreen: false,
  plugins: [react(), appRegionPlugin(), rendererPage()],
  server: {
    port: 5176,
    strictPort: true,
    // Workspace packages (@grind/types, @grind/design) live outside the app.
    fs: { allow: [repoRoot] },
    watch: { ignored: ['**/dist/**', '**/src-tauri/target/**', '**/src-tauri/gen/**'] },
  },
  optimizeDeps: {
    entries: ['lab/index.html', 'lab/surface.html', 'src/main.tsx'],
  },
});

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * `-webkit-app-region` is an Electron/Chromium feature: WKWebView (macOS) drops
 * it, so a Tauri window can only be dragged by calling `startDragging()` from a
 * mousedown. The renderer's styles already say which elements drag and which
 * opt out, so this plugin reads those rules at build time and hands the
 * selectors to `src/dragRegions.ts` — no screen has to change.
 *
 * Only simple rules are understood (`selector { ... -webkit-app-region: x }`,
 * no pseudo-states, no at-rules): that is all the stylesheets contain, and a
 * rule we skip just falls back to "not draggable".
 */
const VIRTUAL = 'virtual:app-region';
const RESOLVED = `\0${VIRTUAL}`;
const here = fileURLToPath(new URL('.', import.meta.url));

export interface AppRegionSelectors {
  drag: string[];
  noDrag: string[];
}

function cssFiles(): string[] {
  const designSrc = resolve(here, '../../../packages/design/src');
  const design = readdirSync(designSrc).filter((f) => f.endsWith('.css')).map((f) => resolve(designSrc, f));
  return [resolve(here, '../src/styles.css'), ...design];
}

export function extractAppRegions(css: string): AppRegionSelectors {
  const out: AppRegionSelectors = { drag: [], noDrag: [] };
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of plain.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const [, selectorList, body] = match;
    const region = /-webkit-app-region\s*:\s*(drag|no-drag)/.exec(body ?? '')?.[1];
    if (!region || !selectorList) continue;
    const bucket = region === 'drag' ? out.drag : out.noDrag;
    for (const selector of selectorList.split(',')) {
      const trimmed = selector.trim();
      if (trimmed && !trimmed.includes(':')) bucket.push(trimmed);
    }
  }
  return out;
}

export function appRegionPlugin(): Plugin {
  return {
    name: 'timo:app-region',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
    load(id) {
      if (id !== RESOLVED) return null;
      const all: AppRegionSelectors = { drag: [], noDrag: [] };
      for (const file of cssFiles()) {
        this.addWatchFile(file);
        const found = extractAppRegions(readFileSync(file, 'utf8'));
        all.drag.push(...found.drag);
        all.noDrag.push(...found.noDrag);
      }
      return `export default ${JSON.stringify(all)};`;
    },
  };
}

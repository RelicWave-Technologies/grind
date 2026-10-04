// playwright.mjs — Playwright, from wherever it is installed. Timo does not depend on it; the
// films are made on a machine that has it somewhere. Set PLAYWRIGHT to its index.mjs, or run
// from a checkout that has it in node_modules.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

async function load() {
  if (process.env.PLAYWRIGHT) return import(pathToFileURL(process.env.PLAYWRIGHT).href);
  try {
    return await import('playwright');
  } catch {
    const require = createRequire(import.meta.url);
    return import(pathToFileURL(require.resolve('playwright')).href);
  }
}

export const { chromium } = await load();

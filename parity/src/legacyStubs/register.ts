import { register } from 'node:module';

let registered = false;

/**
 * Installs the resolution hook of `hooks.mjs`. Must run before a legacy module
 * that imports `electron` (or another Electron-bound neighbour) is imported.
 */
export function registerLegacyStubs(): void {
  if (registered) return;
  registered = true;
  register('./hooks.mjs', import.meta.url);
}

/** The root of the legacy main process sources, as a file URL prefix. */
export const LEGACY_MAIN = new URL('../../../legacy/agent/src/main/', import.meta.url).href;

/**
 * Imports a legacy module (path relative to `legacy/agent/src/main`, with the
 * `.ts` extension) after installing the stubs. The specifier is computed, so
 * the type checker does not follow it into Electron-only code: callers give the
 * shape they use as `T`.
 */
export async function loadLegacy<T>(relative: string): Promise<T> {
  registerLegacyStubs();
  return (await import(`${LEGACY_MAIN}${relative}`)) as T;
}

let freshCounter = 0;

/**
 * Like `loadLegacy`, but a NEW instance of the module every call, so module-level
 * state (a "last logged" memo, say) starts empty. The query string makes the
 * module URL distinct; the hooks ignore it when matching their table.
 */
export async function loadLegacyFresh<T>(relative: string): Promise<T> {
  registerLegacyStubs();
  freshCounter += 1;
  return (await import(`${LEGACY_MAIN}${relative}?fresh=${freshCounter}`)) as T;
}

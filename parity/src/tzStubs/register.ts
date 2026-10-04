import { register } from 'node:module';

let registered = false;

/** Installs the resolution hook of hooks.mjs. Must run before the real service is imported. */
export function registerTzStubs(): void {
  if (registered) return;
  registered = true;
  register('./hooks.mjs', import.meta.url);
}

/** `legacy/agent/src/main/services/` as a file URL prefix. */
export const SERVICES = new URL('../../../legacy/agent/src/main/services/', import.meta.url).href;

let instance = 0;

/** A fresh instance of a real legacy service (own module state), behind the stubs. */
export async function freshService<T>(file: string): Promise<T> {
  registerTzStubs();
  instance += 1;
  return (await import(`${SERVICES}${file}?scenario=${instance}`)) as T;
}

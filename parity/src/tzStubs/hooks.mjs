// Resolution hook that lets the REAL legacy/agent `services/workspaceTime.ts` and
// `services/agentConfig.ts` run under plain Node: their Electron-bound neighbours
// (`electron`, the logger, the token store, the API client, `env`, the server
// clock) resolve to stubs.ts, and only when imported from one of those two files
// (with or without a `?scenario=N` query, which gives every scenario a fresh
// module instance). Any other import still fails loudly.
const stubs = new URL('./stubs.ts', import.meta.url).href;
const electronStub = new URL('../legacyStubs/electron.ts', import.meta.url).href;
const SERVICES = '/legacy/agent/src/main/services/';

/** importing file (relative to services/) -> specifiers redirected to stubs.ts */
const TABLE = {
  'workspaceTime.ts': new Set(['../logger', './tokenStore', './serverClock']),
  'agentConfig.ts': new Set(['./apiClient', '../env', '../logger', './workspaceTime', './tokenStore']),
};

export async function resolve(specifier, context, nextResolve) {
  const parent = (context.parentURL ?? '').split('?')[0];
  const at = parent.indexOf(SERVICES);
  const file = at === -1 ? null : parent.slice(at + SERVICES.length);
  const redirected = file !== null ? TABLE[file] : undefined;
  if (redirected !== undefined) {
    // Same file the other legacy hooks map `electron` to, so whichever hook runs first agrees.
    if (specifier === 'electron') return { url: electronStub, shortCircuit: true };
    if (redirected.has(specifier)) return { url: stubs, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

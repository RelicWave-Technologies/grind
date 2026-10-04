// Resolution hook for the capture fixtures: lets the REAL
// legacy/agent/src/main/services/capture/capture.ts load under plain Node.
// `electron` and the three Electron-bound neighbours capture.ts imports
// (`../../env`, `../permissions`, `../serverClock`, `../../logger`) resolve to
// stubs.ts, and only when imported from capture.ts, so any other import still
// fails loudly instead of being silently mocked. `sharp` is the real sharp.
const stubs = new URL('./stubs.ts', import.meta.url).href;
const CAPTURE = '/legacy/agent/src/main/services/capture/capture.ts';
const REDIRECTED = new Set(['../../env', '../permissions', '../serverClock', '../../logger']);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: stubs, shortCircuit: true };
  if (REDIRECTED.has(specifier) && (context.parentURL ?? '').endsWith(CAPTURE)) {
    return { url: stubs, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

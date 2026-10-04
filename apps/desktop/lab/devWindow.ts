/**
 * Debug builds only: run the lab's fake `window.agent` INSIDE a real Tauri
 * window, so transparency, shadows, placement and drag of the actual overlays
 * can be looked at with realistic content while the services are unported.
 * Triggered by `?lab` on the page URL, which the shell appends in debug builds
 * when `TIMO_DEV_LAB` is set (see src-tauri/src/windows/spec.rs). Tree-shaken
 * out of production builds (`import.meta.env.DEV` guard in src/main.tsx).
 */
import { createBridge, type PinnedPrompt, type Surface } from './bridge/bridge';
import { scenarioFromParams } from './bridge/scenario';
import { WorldStore } from './bridge/store';

const SURFACES: Record<string, Surface> = {
  '': 'main',
  popover: 'popover',
  floating: 'floating',
  attention: 'attention',
  'ready-to-work': 'ready-to-work',
};
const PROMPTS: PinnedPrompt[] = ['IDLE_WARNING', 'IDLE', 'AWAY', 'PERMISSION'];

export function installLabBridge(): void {
  const params = new URLSearchParams(window.location.search);
  const route = window.location.hash.replace('#', '');
  const promptParam = params.get('prompt');
  window.agent = createBridge(new WorldStore(scenarioFromParams(params)), {
    frame: route || 'main',
    surface: SURFACES[route] ?? 'main',
    prompt: PROMPTS.find((kind) => kind === promptParam) ?? 'IDLE_WARNING',
    reason: params.get('reason') === 'UNTRACKED' ? 'UNTRACKED' : 'SHIFT_START',
  });
}

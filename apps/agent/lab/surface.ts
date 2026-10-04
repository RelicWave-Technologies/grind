/**
 * Agent Lab · surface entry. Runs BEFORE the renderer's own main.tsx (see
 * surface.html) and puts a fake `window.agent` where the preload bridge would
 * be. The renderer code, its styles and its hash routing are untouched.
 *
 *   /lab/surface.html?<scenario>&frame=<id>&tab=…&prompt=…&reason=…#<route>
 *
 * route  — same hash the main process loads: '', popover, floating, attention, ready-to-work
 * tab    — main window only: today | tasks | reports | settings
 * prompt — attention only: IDLE_WARNING | IDLE | AWAY | PERMISSION
 * reason — ready-to-work only: SHIFT_START | UNTRACKED
 */
import { createBridge, type PinnedPrompt, type Surface } from './bridge/bridge';
import { scenarioFromParams } from './bridge/scenario';
import { tellGallery } from './bridge/messages';
import { WorldStore } from './bridge/store';
import { paletteCss } from './palettes';

const params = new URLSearchParams(window.location.search);
const route = window.location.hash.replace('#', '');

const SURFACES: Record<string, Surface> = {
  '': 'main',
  popover: 'popover',
  floating: 'floating',
  attention: 'attention',
  'ready-to-work': 'ready-to-work',
};
const PROMPTS: PinnedPrompt[] = ['IDLE_WARNING', 'IDLE', 'AWAY', 'PERMISSION'];

const surface = SURFACES[route] ?? 'main';
const promptParam = params.get('prompt');
const prompt = PROMPTS.find((kind) => kind === promptParam) ?? 'IDLE_WARNING';
const reason = params.get('reason') === 'UNTRACKED' ? 'UNTRACKED' : 'SHIFT_START';

const frame = params.get('frame') ?? 'alone';

// A palette under review (lab/palettes.ts) overrides the brand ramp for this
// frame only; without the param the renderer draws exactly what DESIGN.md says.
const palette = paletteCss(params.get('palette') ?? '');
if (palette) {
  const style = document.createElement('style');
  style.id = 'lab-palette';
  style.textContent = palette;
  document.head.append(style);
}

// Uncaught errors show on the frame's label in the gallery, so a surface that
// crashed after a restyle edit is obvious without opening devtools.
window.addEventListener('error', (event) => tellGallery(frame, { type: 'error', text: event.message || String(event.error) }));
window.addEventListener('unhandledrejection', (event) => tellGallery(frame, { type: 'error', text: String(event.reason) }));

window.agent = createBridge(new WorldStore(scenarioFromParams(params)), {
  frame,
  surface,
  prompt,
  reason,
});

const TAB_LABELS: Record<string, string> = { tasks: 'Tasks', reports: 'Reports', settings: 'Settings' };
const tabLabel = surface === 'main' ? TAB_LABELS[params.get('tab') ?? ''] : undefined;

/**
 * The main window's tab is React state with no outside switch, so the lab
 * presses the sidebar button, exactly as a person would. It does so again
 * whenever the layout remounts (sign out → sign in), and never fights a tab
 * chosen by hand afterwards.
 */
if (tabLabel) {
  const pressed = new WeakSet<Element>();
  const press = () => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.trim() === tabLabel);
    if (!button || pressed.has(button)) return;
    pressed.add(button);
    button.click();
  };
  new MutationObserver(press).observe(document.documentElement, { childList: true, subtree: true });
}

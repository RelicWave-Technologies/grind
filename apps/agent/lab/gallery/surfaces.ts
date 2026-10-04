import { scenarioToParams, type Scenario } from '../bridge/scenario';

/**
 * Every window the desktop app opens, at the size the main process gives it.
 * Sizes are copied from the main process (it imports Electron, so the browser
 * can't import it) — if one changes there, change it here:
 *
 *   main window      src/main/window.ts                960×640, hiddenInset, lights at 16,18
 *   popover          src/main/popover.ts               300×340
 *   floating bar     src/main/floating.ts              268×44
 *   ready to work    src/main/readyToWork.ts           320×168
 *   attention        src/main/services/trackingAttention.ts  per kind, below
 */
export type GroupId = 'main' | 'popover' | 'floating' | 'prompts' | 'ready';

export interface SurfaceSpec {
  id: string;
  group: GroupId;
  title: string;
  width: number;
  height: number;
  /** Hash the main process loads the renderer with. */
  route: '' | 'popover' | 'floating' | 'attention' | 'ready-to-work';
  params?: Record<string, string>;
  /** 'window' = titled macOS window; 'overlay' = frameless, transparent. */
  chrome: 'window' | 'overlay';
  shownWhen?: (scenario: Scenario) => boolean;
}

export const GROUPS: { id: GroupId; title: string; note: string }[] = [
  { id: 'main', title: 'Main window', note: 'Titled window, hidden-inset title bar. Tabs are React state; the lab presses the sidebar for you.' },
  { id: 'popover', title: 'Menu-bar popover', note: 'Frameless and transparent; the card draws its own edge.' },
  { id: 'floating', title: 'Floating bar', note: 'Always on top while tracking. No OS shadow; the pill fills the window.' },
  { id: 'prompts', title: 'Prompts', note: 'One attention window, sized per prompt. Answering hides it; the lab brings it back.' },
  { id: 'ready', title: 'Ready to work', note: 'Top-right toast at shift start, or after untracked activity.' },
];

const signedIn = (scenario: Scenario) => scenario.auth === 'in';

export const SURFACES: SurfaceSpec[] = [
  { id: 'main-today', group: 'main', title: 'Today', width: 960, height: 640, route: '', params: { tab: 'today' }, chrome: 'window', shownWhen: signedIn },
  { id: 'main-tasks', group: 'main', title: 'Tasks', width: 960, height: 640, route: '', params: { tab: 'tasks' }, chrome: 'window', shownWhen: signedIn },
  { id: 'main-reports', group: 'main', title: 'Reports', width: 960, height: 640, route: '', params: { tab: 'reports' }, chrome: 'window', shownWhen: signedIn },
  { id: 'main-settings', group: 'main', title: 'Settings', width: 960, height: 640, route: '', params: { tab: 'settings' }, chrome: 'window', shownWhen: signedIn },
  { id: 'main-login', group: 'main', title: 'Sign in', width: 960, height: 640, route: '', chrome: 'window', shownWhen: (s) => !signedIn(s) },
  { id: 'popover', group: 'popover', title: 'Popover', width: 300, height: 340, route: 'popover', chrome: 'overlay' },
  { id: 'floating', group: 'floating', title: 'Floating bar', width: 268, height: 44, route: 'floating', chrome: 'overlay' },
  { id: 'prompt-idle-warning', group: 'prompts', title: 'Idle warning', width: 340, height: 280, route: 'attention', params: { prompt: 'IDLE_WARNING' }, chrome: 'overlay' },
  { id: 'prompt-idle', group: 'prompts', title: 'Idle — timer paused', width: 340, height: 280, route: 'attention', params: { prompt: 'IDLE' }, chrome: 'overlay' },
  { id: 'prompt-away', group: 'prompts', title: 'Away — welcome back', width: 360, height: 222, route: 'attention', params: { prompt: 'AWAY' }, chrome: 'overlay' },
  { id: 'prompt-permission', group: 'prompts', title: 'Permissions needed', width: 480, height: 332, route: 'attention', params: { prompt: 'PERMISSION' }, chrome: 'overlay' },
  { id: 'ready-shift-start', group: 'ready', title: 'Shift start', width: 320, height: 168, route: 'ready-to-work', params: { reason: 'SHIFT_START' }, chrome: 'overlay' },
  { id: 'ready-untracked', group: 'ready', title: 'Untracked activity', width: 320, height: 168, route: 'ready-to-work', params: { reason: 'UNTRACKED' }, chrome: 'overlay' },
];

/** macOS traffic lights for the main window (trafficLightPosition {x:16, y:18}). */
export const TRAFFIC_LIGHTS = { x: 16, y: 18, size: 12, gap: 8 };

export function surfaceUrl(surface: SurfaceSpec, scenario: Scenario, palette = 'emiac'): string {
  const params = scenarioToParams(scenario);
  params.set('frame', surface.id);
  if (palette !== 'emiac') params.set('palette', palette);
  for (const [key, value] of Object.entries(surface.params ?? {})) params.set(key, value);
  return `/lab/surface.html?${params.toString()}${surface.route ? `#${surface.route}` : ''}`;
}

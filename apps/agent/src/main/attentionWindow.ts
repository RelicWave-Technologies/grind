import type { BrowserWindow } from 'electron';
import type { AttentionPrompt } from '../shared/attention';
import { log } from './logger';
import {
  activeWorkArea,
  center,
  createOverlayWindow,
  keepOnTop,
  releaseOnTop,
  topRight,
} from './windows/overlay';

/**
 * The Electron adapter behind the attention seam.
 *
 * This module owns a window and nothing else. It does NOT know which prompt is
 * active, which prompt outranks which, or when to stop showing one — that is
 * the tracking-attention coordinator's job, and keeping a second copy of it
 * here is what produced prompts that disagreed with their own coordinator.
 *
 * Everything below is mechanism: put the window somewhere, order it up, report
 * whether it is still up, put it down. The coordinator drives.
 *
 * TWO THINGS DELIBERATELY ABSENT
 *
 *  1. **No focus().** Electron's macOS `focus()` asks the app to activate; from
 *     inside another app's fullscreen Space that makes macOS switch Spaces, and
 *     the deferred activation resolving is what made the prompt flash to the
 *     front and drop back. On Windows it cannot win the foreground lock anyway,
 *     and the `flashFrame` fallback is useless on a `skipTaskbar` window with no
 *     taskbar button to flash. Clicks reach a non-activating panel without it.
 *
 *  2. **No retry ladder, and no `always-on-top-changed` listener.** Both were
 *     attempts to re-raise blind. `onTop()` lets the coordinator look instead,
 *     and the listener actively re-triggered the all-workspaces call that is the
 *     prime suspect for dropping the level in the first place.
 */

export type Placement = 'center' | 'topRight';

export interface PlacementSpec {
  width: number;
  height: number;
  placement: Placement;
}

/**
 * The seam. Two real adapters satisfy it — this one and the fake in the tests —
 * which is what finally makes "is the prompt actually on top?" a value a test
 * can control. Before this existed the suite mocked the float assertion, so no
 * test could observe z-order and every previous fix went green while broken.
 */
export interface OverlayHost {
  /** Position and size the surface. Called once per presentation, not per raise:
   *  re-resolving the work area on every raise teleported the prompt to whichever
   *  display the cursor had wandered to. */
  place(spec: PlacementSpec): void;
  /** Hold the surface at prompt rank until released. Never takes focus, never
   *  activates. The shared overlay keeper does the repeating. */
  keep(): void;
  /** Stop holding. Leaves the surface where it is. */
  release(): void;
  /** Observation, not a control: is the surface visible AND still floating?
   *  Logged as evidence. Deliberately NOT used to decide whether to re-raise —
   *  it cannot tell "still floating but buried" from healthy, and the timer bar
   *  proves an unconditional re-raise is what actually holds a window up. */
  onTop(): boolean;
  /** Stand down without hiding — used while the user is in System Settings. */
  lower(): void;
  hide(): void;
  /** Push prompt state to the renderer. Takes the prompt as an argument rather
   *  than reading a cached copy — this module stores no prompt state. */
  publish(prompt: AttentionPrompt): void;
  /** Register a callback for when the renderer has loaded. Fires immediately if
   *  it already has. */
  onReady(listener: () => void): void;
  isReady(): boolean;
}

// Largest surface any prompt uses; the window is created at this size and
// `place()` resizes per prompt.
const INITIAL_SIZE = { width: 480, height: 332 };

let win: BrowserWindow | null = null;
let loaded = false;
const readyListeners = new Set<() => void>();

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  loaded = false;
  win = createOverlayWindow({
    ...INITIAL_SIZE,
    hash: 'attention',
    roundedCorners: true,
    rank: 'prompt',
    // The coordinator's hold loop owns this window's float; it must not also be
    // swept by the global wake/display re-assertion, which knows nothing about
    // whether the prompt is currently yielded to System Settings.
    registerForReassert: false,
  });
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    for (const listener of readyListeners) listener();
  });
  win.on('closed', () => {
    win = null;
    loaded = false;
  });
  return win;
}

// Last observed float state, so the log records transitions rather than a line
// every second for as long as a prompt is on screen.
let lastFloatOk: boolean | null = null;

/**
 * The evidence that settles why a prompt gets buried, logged only when it
 * changes.
 *
 * `floating: false` while a prompt is being held means the always-on-top level
 * was lost and something reset it. `floating: true` while the user still
 * reports the prompt is covered means another application is floating at a
 * comparable level, and no amount of re-raising at this rank will help.
 */
function noteFloatState(window: BrowserWindow): void {
  const ok = window.isVisible() && window.isAlwaysOnTop();
  if (ok === lastFloatOk) return;
  lastFloatOk = ok;
  log.info('attention float state', {
    floating: ok,
    visible: window.isVisible(),
    alwaysOnTop: window.isAlwaysOnTop(),
  });
}

function pointFor(spec: PlacementSpec): { x: number; y: number } {
  const workArea = activeWorkArea();
  const size = { width: spec.width, height: spec.height };
  return spec.placement === 'topRight' ? topRight(workArea, size) : center(workArea, size);
}

export const attentionHost: OverlayHost = {
  place(spec) {
    const window = ensure();
    const point = pointFor(spec);
    window.setBounds({ ...point, width: spec.width, height: spec.height }, false);
  },

  keep() {
    const window = ensure();
    keepOnTop(window);
    noteFloatState(window);
  },

  release() {
    releaseOnTop(win);
  },

  onTop() {
    if (!win || win.isDestroyed()) return false;
    return win.isVisible() && win.isAlwaysOnTop();
  },

  lower() {
    if (!win || win.isDestroyed()) return;
    releaseOnTop(win);
    win.setAlwaysOnTop(false);
    win.blur();
  },

  hide() {
    releaseOnTop(win);
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  },

  publish(prompt) {
    if (loaded && win && !win.isDestroyed()) win.webContents.send('attention:state:push', prompt);
  },

  onReady(listener) {
    readyListeners.add(listener);
    ensure();
    if (loaded) listener();
  },

  isReady() {
    return loaded;
  },
};

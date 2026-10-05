import { app } from 'electron';
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
 * ONE WINDOW PER PRESENTATION
 *
 *  1. **`hide()` destroys.** A window joins the Spaces that exist when it is
 *     built and no others, so a prompt window kept alive across prompts ends
 *     up stranded on a Space the person has left. The coordinator therefore
 *     discards the surface before every presentation and the next `place()`
 *     builds a fresh one. That is cheap, and it is what reaches the current
 *     Space — without activating the app.
 *
 *  2. **`activate()` is for blocking prompts only.** `app.focus({steal:true})`
 *     pulls the person out of whatever they were in, including a fullscreen
 *     Space. Only a prompt that blocks tracking (PERMISSION) earns that; the
 *     idle and welcome-back prompts are shown inactive by the keeper. The ~1 Hz
 *     keeper must never activate.
 *
 *  3. **No retry ladder, and no `always-on-top-changed` listener.** Both were
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
  /** Position and size the surface, building it if there is none. Called per
   *  presentation (and when the displays change), not per raise: re-resolving
   *  the work area on every raise teleported the prompt to whichever display
   *  the cursor had wandered to. */
  place(spec: PlacementSpec): void;
  /** Show the surface inactive and hold it at prompt rank until released.
   *  Never takes focus, never activates. The shared overlay keeper does the
   *  repeating. */
  keep(): void;
  /** Stop holding. Leaves the surface where it is. */
  release(): void;
  /** Observation, not a control: is the surface visible AND still floating?
   *  Logged as evidence. Deliberately NOT used to decide whether to re-raise —
   *  it cannot tell "still floating but buried" from healthy, and the timer bar
   *  proves an unconditional re-raise is what actually holds a window up. */
  onTop(): boolean;
  /**
   * Bring the app and this surface to the front and give it keyboard focus.
   * Only for a prompt that blocks tracking until answered, and only once per
   * presentation — never from the keeper, whose ~1 Hz cadence is what turned
   * activation into focus-stealing before.
   */
  activate(): void;
  /** Stand down without hiding — used while the user is in System Settings. */
  lower(): void;
  /** Discard the surface. The next `place()` builds a fresh one. */
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

// Last observed float state, so the log records transitions rather than a line
// every second for as long as a prompt is on screen.
let lastFloatOk: boolean | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  loaded = false;
  lastFloatOk = null;
  const created = createOverlayWindow({
    ...INITIAL_SIZE,
    hash: 'attention',
    roundedCorners: true,
    rank: 'prompt',
    // The coordinator owns this window's float; it must not also be swept by
    // the global wake/display re-assertion, which knows nothing about whether
    // the prompt is currently yielded to System Settings.
    registerForReassert: false,
  });
  win = created;
  created.webContents.on('did-finish-load', () => {
    // A load finishing for a surface that has since been discarded is not
    // the current surface becoming ready.
    if (win !== created) return;
    loaded = true;
    for (const listener of readyListeners) listener();
  });
  created.on('closed', () => {
    if (win !== created) return;
    win = null;
    loaded = false;
  });
  return created;
}

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

  activate() {
    const window = ensure();
    if (process.platform === 'darwin') {
      // Only a real activation reaches a Space the window was not born into.
      app.focus({ steal: true });
    }
    window.show();
    window.focus();
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
    const discarded = win;
    win = null;
    loaded = false;
    if (!discarded) return;
    releaseOnTop(discarded);
    if (!discarded.isDestroyed()) discarded.destroy();
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

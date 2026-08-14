import type { BrowserWindow } from 'electron';
import type { AttentionPrompt } from '../shared/attention';
import { log } from './logger';
import {
  activeWorkArea,
  assertOverlayFloat,
  center,
  createOverlayWindow,
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
  /** Order the surface up at its rank. Never takes focus, never activates. */
  raise(): void;
  /** Cheap truth: is the surface still visible AND still floating? A dropped
   *  always-on-top level reads as false here, which is exactly the failure that
   *  lets ordinary windows cover a screen-saver-level prompt. */
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

  raise() {
    const window = ensure();
    const onTopBefore = window.isAlwaysOnTop();
    const visibleBefore = window.isVisible();

    assertOverlayFloat(window);
    // macOS: a non-activating panel can be dropped from the onscreen list across
    // Space/fullscreen transitions while Electron still reports it visible, so
    // showing is unconditional there and idempotent everywhere else.
    if (process.platform === 'darwin' || !window.isVisible()) window.showInactive();
    window.moveTop();

    // The one field that settles why a prompt gets buried: if `onTopBefore` is
    // false while a prompt is being held, the always-on-top level was lost and
    // something reset it. If it is true and the prompt is still covered, another
    // application is floating at a comparable level and rank cannot help.
    log.info('attention raise', {
      onTopBefore,
      visibleBefore,
      onTopAfter: window.isAlwaysOnTop(),
      visibleAfter: window.isVisible(),
    });
  },

  onTop() {
    if (!win || win.isDestroyed()) return false;
    return win.isVisible() && win.isAlwaysOnTop();
  },

  lower() {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    win.blur();
  },

  hide() {
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

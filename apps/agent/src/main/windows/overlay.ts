import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

/**
 * Foundation for every always-on-top overlay the agent shows: the floating
 * timer bar, the idle "still working?" prompt, the "ready to work?" shift
 * toast, and the tray popover.
 *
 * Three things these windows MUST get right, and historically each file did
 * slightly differently:
 *
 *   1. **Float over anything, on any Space.** `screen-saver` always-on-top
 *      level + `visibleOnFullScreen` so the window sits above a fullscreen
 *      Zoom/Keynote/browser and follows the user across virtual desktops.
 *      These flags are NOT sticky — macOS drops them after display sleep and
 *      some Space transitions (electron#36364) — so they must be re-asserted
 *      on every show AND on wake/display change, not just at creation.
 *
 *   2. **Appear on the display the user is actually looking at.** Positioning
 *      on `getPrimaryDisplay()` strands a popup on monitor 1 while the user
 *      works fullscreen on monitor 2. We anchor to the display under the
 *      cursor instead.
 *
 *   3. **One definition.** A single factory + a single float-assertion + a
 *      registry so a lone power/display handler can re-assert every live
 *      overlay at once.
 */

export interface Size {
  width: number;
  height: number;
}

export interface OverlayOptions extends Size {
  /** Renderer hash-route (e.g. 'floating', 'idle', 'ready-to-work', 'popover'). */
  hash: string;
  /** Native OS window shadow. Turn OFF for a surface that draws its own CSS
   *  shadow inside transparent padding — otherwise the OS backing/shadow is
   *  drawn on the full window rect and peeks past the surface's rounded corners. */
  hasShadow?: boolean;
  /** OS corner rounding. Set false to let CSS own the shape completely, so a
   *  DWM/AppKit corner radius can't mismatch the surface's own border-radius. */
  roundedCorners?: boolean;
  /** Interactive overlays must be capable of becoming key when clicked.
   * Passive surfaces use an NSPanel on macOS so they never activate the app. */
  activation?: 'passive' | 'interactive';
  /** Most overlays share the global wake/display reassertion registry. A
   * coordinator-owned window can opt out when its own state controls whether
   * it should float (for example, while yielding to System Settings). */
  registerForReassert?: boolean;
}

// Live overlays — used by reassertAllOverlays() on wake / display change.
const registry = new Set<BrowserWindow>();
// Electron briefly transforms a normal macOS app into a UIElement application
// while applying fullscreen-Space membership. Do that once per window during
// normal presentation; wake/display recovery can explicitly refresh it.
const workspaceVisibilityConfigured = new WeakSet<BrowserWindow>();

export interface OverlayFloatOptions {
  refreshWorkspaceVisibility?: boolean;
}

function loadRoute(w: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }
}

/**
 * Create a frameless, transparent overlay window with shared hardened
 * webPreferences. Auto-registers for float re-assertion and deregisters on
 * close. Passive overlays use NSPanel; interactive overlays can become key
 * windows through explicit user interaction.
 */
export function createOverlayWindow(opts: OverlayOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: opts.hasShadow ?? true,
    roundedCorners: opts.roundedCorners ?? true,
    // NSPanel is correct for passive surfaces, but cannot reliably become the
    // key window for a permission flow opened from an already-visible window.
    type: process.platform === 'darwin' && opts.activation !== 'interactive' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });
  loadRoute(win, opts.hash);
  if (opts.registerForReassert !== false) {
    registry.add(win);
    win.on('closed', () => registry.delete(win));
  }
  return win;
}

/**
 * Canonical "float over everything, on every Space" assertion.
 *
 * `setVisibleOnAllWorkspaces` must use Electron's default macOS process-type
 * transition. Skipping that transition is only valid for apps which are
 * already UIElement applications; Timo is a normal foreground app. Because
 * the transition may briefly hide the Dock, it is applied once per window and
 * explicitly refreshed only after wake/unlock/display changes.
 */
export function assertOverlayFloat(
  win: BrowserWindow | null,
  options: OverlayFloatOptions = {},
): void {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (options.refreshWorkspaceVisibility || !workspaceVisibilityConfigured.has(win)) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    workspaceVisibilityConfigured.add(win);
  }
}

/** Re-assert float on every live overlay (wake / Space / display change). */
export function reassertAllOverlays(): void {
  for (const w of registry) {
    assertOverlayFloat(w, { refreshWorkspaceVisibility: true });
  }
}

/**
 * Work area of the display under the cursor — the best proxy for "where the
 * user is looking right now". Falls back to the primary display if the cursor
 * point can't be resolved (shouldn't happen, but never throw on a show path).
 */
export function activeWorkArea(): Electron.Rectangle {
  try {
    const pt = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(pt).workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

// --- Pure placement helpers (work area + size in, point out) ----------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

/** Centered in the usable desktop area — used by blocking attention prompts. */
export function center(wa: Rect, size: Size): Point {
  return {
    x: Math.round(wa.x + (wa.width - size.width) / 2),
    y: Math.round(wa.y + (wa.height - size.height) / 2),
  };
}

/** Top-right with a gutter — used by the "ready to work?" toast. */
export function topRight(wa: Rect, size: Size, gutter = 16): Point {
  return {
    x: Math.round(wa.x + wa.width - size.width - gutter),
    y: Math.round(wa.y + gutter),
  };
}

/** Bottom-right with a gutter — the floating bar's default home. */
export function bottomRight(wa: Rect, size: Size, gutter = 20): Point {
  return {
    x: Math.round(wa.x + wa.width - size.width - gutter),
    y: Math.round(wa.y + wa.height - size.height - gutter),
  };
}

/** Tray popover placement: below top menu bars, above bottom taskbars. */
export function trayPopoverPoint(tray: Rect, wa: Rect, size: Size, gutter = 6): Point {
  const minX = wa.x + gutter;
  const maxX = wa.x + wa.width - size.width - gutter;
  const centeredX = tray.x + tray.width / 2 - size.width / 2;
  const x = Math.round(clamp(centeredX, minX, Math.max(minX, maxX)));

  const minY = wa.y + gutter;
  const maxY = wa.y + wa.height - size.height - gutter;
  const belowY = tray.y + tray.height + gutter;
  const aboveY = tray.y - size.height - gutter;
  const fitsBelow = belowY + size.height <= wa.y + wa.height - gutter;
  const preferredY = fitsBelow ? belowY : aboveY;
  const y = Math.round(clamp(preferredY, minY, Math.max(minY, maxY)));

  return { x, y };
}

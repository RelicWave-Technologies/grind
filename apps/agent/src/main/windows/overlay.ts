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

/**
 * Precedence between overlays.
 *
 * `ambient` is the always-there furniture (timer bar, tray popover, shift
 * toast). `prompt` is a surface that is asking the user for something and must
 * not be buried by the furniture.
 *
 * Both ranks float; the rank decides who wins when they overlap. It is enforced
 * two ways because one is not portable:
 *
 *   - macOS: a relative window level, so an ambient `moveTop()` physically
 *     cannot order itself above a prompt.
 *   - everywhere (and the only mechanism on Windows, where Electron collapses
 *     every non-normal always-on-top level into one topmost band): ambient
 *     raises are suppressed while a prompt is being held. See `holdPrompt()`.
 */
export type OverlayRank = 'ambient' | 'prompt';

export interface OverlayOptions extends Size {
  /** Renderer hash-route (e.g. 'floating', 'idle', 'ready-to-work', 'popover'). */
  hash: string;
  /** Precedence against other overlays. Defaults to `ambient`. */
  rank?: OverlayRank;
  /** Native OS window shadow. Turn OFF for a surface that draws its own CSS
   *  shadow inside transparent padding — otherwise the OS backing/shadow is
   *  drawn on the full window rect and peeks past the surface's rounded corners. */
  hasShadow?: boolean;
  /** OS corner rounding. Set false to let CSS own the shape completely, so a
   *  DWM/AppKit corner radius can't mismatch the surface's own border-radius. */
  roundedCorners?: boolean;
  /** Most overlays share the global wake/display reassertion registry. A
   * coordinator-owned window can opt out when its own state controls whether
   * it should float (for example, while yielding to System Settings). */
  registerForReassert?: boolean;
}

// Live overlays — used by reassertAllOverlays() on wake / display change.
const registry = new Set<BrowserWindow>();
const workspaceVisibilityConfigured = new WeakSet<BrowserWindow>();
const ranks = new WeakMap<BrowserWindow, OverlayRank>();

/** macOS window level offset per rank. Ignored on Windows/Linux, where Electron
 *  has a single topmost band and precedence comes from suppression instead. */
function relativeLevelFor(rank: OverlayRank): number {
  return rank === 'prompt' ? 1 : 0;
}

export function overlayRankOf(win: BrowserWindow): OverlayRank {
  return ranks.get(win) ?? 'ambient';
}

/* --- The keeper ----------------------------------------------------------
 *
 * ONE policy for staying on top, for every overlay.
 *
 * This exists because the app already contained the answer. The timer bar has
 * never fallen behind, and the only thing distinguishing it from the surfaces
 * that do is that it re-asserted itself roughly twice a second, forever, off
 * the main tick. The prompt re-asserted four times in its first second and then
 * stopped; the shift toast raised once per show. Same factory, same window
 * level, same non-activating panel — the difference was cadence, and one of the
 * four callers happened to get it right.
 *
 * So the module owns the cadence now instead of handing callers `moveTop()` and
 * hoping. `keepOnTop` / `releaseOnTop` is the whole interface.
 *
 * The re-raise is DELIBERATELY UNCONDITIONAL. Gating it on a cheap "am I still
 * on top?" probe reads better but bets that `isAlwaysOnTop()` detects the real
 * failure — and it cannot distinguish "still floating but buried" from healthy.
 * The bar never checks anything, and the bar is the one that works.
 *
 * COST. One shared interval, and none at all while nothing is on screen:
 *   - no overlay shown           -> no timer exists
 *   - any overlay shown          -> one 1 Hz timer, shared by all of them
 *   - hidden/destroyed windows   -> skipped without any native call
 *   - already-kept window        -> keepOnTop() is a no-op, so the 1 Hz
 *                                   syncFloatingBar() call costs nothing
 * Per visible overlay per second that is one level assert, one conditional
 * show, and one order-to-front — slightly fewer native calls than the timer bar
 * made on its own before this existed.
 */
const KEEP_INTERVAL_MS = 1_000;
const kept = new Set<BrowserWindow>();
let keeperTimer: ReturnType<typeof setInterval> | null = null;

/** True while a visible prompt-ranked overlay is being kept on top. Derived, so
 *  it cannot drift out of sync with what is actually on screen. */
function promptHeld(): boolean {
  for (const win of kept) {
    if (!win.isDestroyed() && win.isVisible() && overlayRankOf(win) === 'prompt') return true;
  }
  return false;
}

/**
 * Whether an ambient overlay may re-order itself to the front right now.
 *
 * False while a prompt is held: on Windows every always-on-top level collapses
 * into a single band, so the only thing stopping the timer bar's 1 Hz
 * `moveTop()` from climbing back over a prompt is declining to make the call.
 */
export function ambientRaiseAllowed(): boolean {
  return !promptHeld();
}

function raiseNow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const ambient = overlayRankOf(win) === 'ambient';
  if (ambient && !ambientRaiseAllowed()) {
    // Still keep it floating, just don't let it climb over the prompt.
    assertOverlayFloat(win);
    return;
  }
  assertOverlayFloat(win);
  if (!win.isVisible()) {
    win.showInactive();
  } else if (process.platform === 'darwin' && !win.isFocused()) {
    // macOS can drop a non-activating panel from the onscreen window list while
    // Electron still reports it visible after a Space/fullscreen transition.
    // Skipped when focused so a click-to-dismiss surface keeps its key status.
    win.showInactive();
  }
  win.moveTop();
}

function keeperTick(): void {
  for (const win of kept) {
    if (win.isDestroyed()) {
      kept.delete(win);
      continue;
    }
    if (!win.isVisible()) continue;
    raiseNow(win);
  }
  if (kept.size === 0) stopKeeper();
}

function startKeeper(): void {
  if (keeperTimer) return;
  keeperTimer = setInterval(keeperTick, KEEP_INTERVAL_MS);
  keeperTimer.unref?.();
}

function stopKeeper(): void {
  if (!keeperTimer) return;
  clearInterval(keeperTimer);
  keeperTimer = null;
}

/**
 * Hold this overlay at its rank until released. Idempotent: calling it again
 * for a window already being kept does nothing, which is what makes it safe to
 * call from the 1 Hz tick.
 */
export function keepOnTop(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || kept.has(win)) return;
  kept.add(win);
  raiseNow(win);
  startKeeper();
}

/** Stop holding this overlay. The shared timer stops when the last one goes. */
export function releaseOnTop(win: BrowserWindow | null): void {
  if (!win) return;
  kept.delete(win);
  if (kept.size === 0) stopKeeper();
}

/** Test seam: run one keeper pass without waiting on a real timer. */
export function __keeperTickForTests(): void {
  keeperTick();
}

/** Test seam: forget every kept overlay. */
export function __resetKeeperForTests(): void {
  kept.clear();
  stopKeeper();
}

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
 * close. Every overlay is a non-activating NSPanel on macOS: panels float
 * over other apps' fullscreen Spaces and become key for clicks without
 * activating the app (which would make macOS switch Spaces).
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
    // Born floating. The original idle prompt (the version that never fell
    // behind) set this at construction; every rewrite since has relied purely
    // on a post-construction setAlwaysOnTop, leaving a window in which the
    // surface exists un-floated. Costs nothing to close that gap.
    alwaysOnTop: true,
    hasShadow: opts.hasShadow ?? true,
    roundedCorners: opts.roundedCorners ?? true,
    // Non-activating NSPanel: floats over other apps' fullscreen Spaces and
    // accepts clicks/key status without activating the app — activating a
    // regular app from another app's fullscreen Space makes macOS switch
    // Spaces, yanking the user to the desktop.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });
  ranks.set(win, opts.rank ?? 'ambient');
  // Attached once, here — NOT in keepOnTop. A surface can be kept and released
  // many times over a session (the tray popover does it on every click), and
  // registering the cleanup per keep stacked a listener that never fires on a
  // window that never closes, tripping Node's max-listeners warning and leaking
  // for the lifetime of the process.
  win.on('closed', () => releaseOnTop(win));
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
 * `skipTransformProcessType` is REQUIRED, and the reason is empirical.
 *
 * Electron's default all-workspaces path toggles the macOS process type to
 * UIElement and back to configure Spaces. Timo has several overlays and now
 * builds a fresh prompt window per prompt, so that path runs many times per
 * session — and each run can leave a Dock tile behind. Five stacked Timo tiles
 * in the Dock is what that looks like.
 *
 * This has been round-tripped once already, so it is worth being explicit:
 * 3a78ab5 let the transition run and called `ensureRegularMacApplication()`
 * after it; b8fa826 then added this flag precisely BECAUSE that produced stale
 * tiles. beta.35 briefly restored the transition on the theory that suppressing
 * it was why all-Spaces membership did not survive a new Space — the tiles came
 * straight back, so the theory is refuted and the flag stays.
 *
 * Stranding is addressed instead by never letting a prompt window outlive the
 * Spaces it joined (see attentionWindow.hide, which destroys rather than hides).
 *
 * Note that every overlay — prompts included — is a non-activating NSPanel;
 * nothing here activates the app.
 *
 * ORDER MATTERS. The always-on-top level is asserted LAST, after the
 * all-workspaces call, because that call reconfigures the window's collection
 * behaviour and is the prime suspect for the level being silently reset —
 * the failure users see as "the prompt is still there but ordinary windows are
 * now on top of it". Whoever writes last wins, so the level writes last.
 */
export function assertOverlayFloat(
  win: BrowserWindow | null,
  options: OverlayFloatOptions = {},
): void {
  if (!win || win.isDestroyed()) return;
  if (
    options.refreshWorkspaceVisibility
    || !workspaceVisibilityConfigured.has(win)
  ) {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    workspaceVisibilityConfigured.add(win);
  }
  win.setAlwaysOnTop(true, 'screen-saver', relativeLevelFor(overlayRankOf(win)));
}

/**
 * Re-assert float on every live overlay (wake / Space / display change).
 *
 * Covers the keeper's windows as well as the reassert registry, and they are
 * NOT the same set — a coordinator-owned surface like the attention prompt opts
 * out of the registry so its own state decides whether it should float.
 *
 * That distinction matters because the keeper cannot do this itself. Its 1 Hz
 * raise deliberately calls `assertOverlayFloat` without
 * `refreshWorkspaceVisibility`, since Electron's all-workspaces path touches
 * Dock/activation state and must not run at that rate — and the WeakSet inside
 * makes every call after the first a no-op. So a held prompt would keep its
 * always-on-top level across a sleep but silently lose the collection
 * behaviours that put it above a fullscreen app and on every Space.
 */
export function reassertAllOverlays(): void {
  const seen = new Set<BrowserWindow>();
  for (const w of [...registry, ...kept]) {
    if (seen.has(w) || w.isDestroyed()) continue;
    seen.add(w);
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

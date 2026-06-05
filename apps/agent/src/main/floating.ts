import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { getPreferences, patchFloatingBar } from './services/preferences';
import { resolvePosition, type Rect } from './windows/floatingBarPosition';
import { createOverlayWindow, assertOverlayFloat, activeWorkArea, bottomRight } from './windows/overlay';

/**
 * Always-on-top mini bar shown while tracking (M2).
 *
 * Position ownership: once the user drags the bar, THEY own its position. We
 * persist every drag (debounced) and never reposition on subsequent shows —
 * the 1s heartbeat calls showFloatingBar() repeatedly, and it must be a no-op
 * when already visible. The bar only snaps to the default corner on first run,
 * after an explicit "reset", or when the saved spot is off-screen (a monitor
 * was unplugged).
 *
 * Visibility: gated by the per-device `floatingBar.visible` preference. When a
 * user turns it off in Settings it stays hidden even while tracking.
 */

const SIZE = { width: 248, height: 56 };

let win: BrowserWindow | null = null;
let wantVisible = false; // mirror of "timer running" — set by the heartbeat
let moveSaveTimer: NodeJS.Timeout | null = null;

function toRect(wa: Electron.Rectangle): Rect {
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
}

/**
 * Resolve where the bar should sit right now. A saved (dragged) position wins
 * whenever it's still on a visible display; otherwise we default to the
 * bottom-right of the display the user is currently on (not always primary).
 */
function computePosition(): { x: number; y: number } {
  const prefs = getPreferences().floatingBar;
  const saved = prefs.x != null && prefs.y != null ? { x: prefs.x, y: prefs.y } : null;
  const all = screen.getAllDisplays().map((d) => toRect(d.workArea));
  if (saved) {
    // resolvePosition keeps it if visible, else falls back; the fallback arg
    // is the active display's corner so a reset/off-screen lands where the
    // user is looking.
    const fallbackPrimary = toRect(activeWorkArea());
    return resolvePosition(saved, SIZE, fallbackPrimary, all);
  }
  return bottomRight(activeWorkArea(), SIZE);
}

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ width: SIZE.width, height: SIZE.height, hash: 'floating' });

  const p = computePosition();
  win.setPosition(p.x, p.y, false);

  // The user owns position once they drag. Persist every move (debounced so a
  // drag's burst of events doesn't thrash the disk). 'moved' fires on macOS +
  // Windows after the window settles.
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => patchFloatingBar({ x, y }), 150);
  });
  win.on('closed', () => {
    win = null;
  });

  reassertFloating();
  return win;
}

/** Keep it above everything, including fullscreen apps and across Spaces. */
export function reassertFloating(): void {
  assertOverlayFloat(win);
}

/**
 * Show the bar (idempotent). Honors the visibility preference: if the user
 * disabled it, this does nothing. Does NOT reposition an already-placed bar —
 * that's what kept snapping it back to the corner.
 */
export function showFloatingBar(): void {
  wantVisible = true;
  if (!getPreferences().floatingBar.visible) return;
  const w = ensure();
  if (!w.isVisible()) w.showInactive();
  reassertFloating();
}

export function hideFloatingBar(): void {
  wantVisible = false;
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

/**
 * React to a Settings toggle. Turning it OFF hides immediately; turning it ON
 * shows again only if the timer is currently running (wantVisible).
 */
export function applyFloatingBarVisibility(visible: boolean): void {
  patchFloatingBar({ visible });
  if (!visible) {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  } else if (wantVisible) {
    showFloatingBar();
  }
}

/**
 * Reset to the default corner ("bring it back"). Clears the saved coords and,
 * if the bar exists, moves it there now.
 */
export function resetFloatingBarPosition(): void {
  patchFloatingBar({ x: null, y: null });
  if (win && !win.isDestroyed()) {
    const p = computePosition();
    win.setPosition(p.x, p.y, false);
  }
}

/** Re-clamp when displays change (monitor unplugged / resolution change). */
export function reclampFloatingBar(): void {
  if (!win || win.isDestroyed()) return;
  const p = computePosition();
  const [cx, cy] = win.getPosition();
  if (cx !== p.x || cy !== p.y) win.setPosition(p.x, p.y, false);
}

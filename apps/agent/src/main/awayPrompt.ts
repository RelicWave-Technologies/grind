import type { BrowserWindow } from 'electron';
import { createOverlayWindow, assertOverlayFloat, activeWorkArea, topRight } from './windows/overlay';

/**
 * "Welcome back — resume tracking?" toast. Shown at the top-right when the user
 * returns from a lock/sleep that stopped a running timer (see power.ts). A
 * notification, not a modal — it never steals focus. The renderer (AwayPrompt)
 * reads the context via `away:get` and acts via `away:resume` / `away:dismiss`.
 */

export type AwayInfo = { larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' };

const SIZE = { width: 320, height: 176 };
let win: BrowserWindow | null = null;
let info: AwayInfo | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ ...SIZE, hash: 'away' });
  assertOverlayFloat(win);
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function showAwayPrompt(next: AwayInfo): void {
  info = next;
  const w = ensure();
  const p = topRight(activeWorkArea(), SIZE);
  w.setPosition(p.x, p.y, false);
  assertOverlayFloat(w); // re-assert: float flags drop after sleep/Space switch
  w.showInactive(); // notify, don't interrupt
}

export function hideAwayPrompt(): void {
  info = null;
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

/** The context for the renderer to render + act on. Null once resolved/dismissed. */
export function getAwayInfo(): AwayInfo | null {
  return info;
}

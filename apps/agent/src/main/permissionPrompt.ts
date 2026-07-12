import { app, type BrowserWindow } from 'electron';
import {
  activeWorkArea,
  assertOverlayFloat,
  centerUpperThird,
  createOverlayWindow,
} from './windows/overlay';
import { hideAwayPrompt } from './awayPrompt';
import { hideIdlePrompt } from './idlePrompt';
import { hidePopover } from './popover';

const SIZE = { width: 480, height: 332 };
let win: BrowserWindow | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({
    ...SIZE,
    hash: 'permissions',
    roundedCorners: true,
    activation: 'interactive',
  });
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function showPermissionPrompt(): void {
  hideAwayPrompt();
  hideIdlePrompt();
  hidePopover();
  const window = ensure();
  const point = centerUpperThird(activeWorkArea(), SIZE);
  window.setPosition(point.x, point.y, false);
  assertOverlayFloat(window);
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.moveTop();
  window.focus();
}

export function focusPermissionPromptIfVisible(): boolean {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  assertOverlayFloat(win);
  win.moveTop();
  win.focus();
  return true;
}

export function hidePermissionPrompt(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

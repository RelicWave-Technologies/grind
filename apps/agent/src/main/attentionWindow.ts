import { app, type BrowserWindow } from 'electron';
import type { AttentionPrompt } from '../shared/attention';
import {
  activeWorkArea,
  assertOverlayFloat,
  center,
  createOverlayWindow,
  topRight,
} from './windows/overlay';

const SIZES = {
  IDLE: { width: 340, height: 280 },
  AWAY: { width: 320, height: 176 },
  PERMISSION: { width: 480, height: 332 },
} as const;
const RAISE_RETRY_MS = [100, 400] as const;

let win: BrowserWindow | null = null;
let loaded = false;
let current: AttentionPrompt = { kind: 'NONE' };
let presentationGeneration = 0;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  loaded = false;
  win = createOverlayWindow({
    ...SIZES.PERMISSION,
    hash: 'attention',
    roundedCorners: true,
    activation: 'interactive',
    registerForReassert: false,
  });
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    publish();
    if (current.kind !== 'NONE') presentCurrent(true);
  });
  win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop && isFront(current)) queueMicrotask(() => reassertAttentionWindow(false));
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => {
    win = null;
    loaded = false;
  });
  return win;
}

function isFront(prompt: AttentionPrompt): boolean {
  return prompt.kind !== 'NONE'
    && (prompt.kind !== 'PERMISSION' || prompt.presentation === 'FRONT');
}

function publish(): void {
  if (loaded && win && !win.isDestroyed()) win.webContents.send('attention:state:push', current);
}

function applyBounds(window: BrowserWindow, prompt: Exclude<AttentionPrompt, { kind: 'NONE' }>): void {
  const size = SIZES[prompt.kind];
  const workArea = activeWorkArea();
  const point = prompt.kind === 'AWAY'
    ? topRight(workArea, size)
    : center(workArea, size);
  window.setBounds({ ...point, ...size }, false);
}

function raise(window: BrowserWindow, takeFocus: boolean): void {
  assertOverlayFloat(window);
  if (!window.isVisible()) window.show();
  window.moveTop();
  if (!takeFocus) return;
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  if (process.platform === 'win32' && !window.isFocused()) window.flashFrame(true);
}

function presentCurrent(takeFocus: boolean): void {
  if (current.kind === 'NONE') return;
  const window = ensure();
  applyBounds(window, current);
  publish();
  if (!loaded) return;
  if (current.kind === 'PERMISSION' && current.presentation === 'YIELDED_TO_SETTINGS') {
    window.setAlwaysOnTop(false);
    window.blur();
    return;
  }

  const generation = ++presentationGeneration;
  raise(window, takeFocus);
  for (const delay of RAISE_RETRY_MS) {
    setTimeout(() => {
      if (generation !== presentationGeneration || !isFront(current)) return;
      if (!win || win.isDestroyed()) return;
      applyBounds(win, current as Exclude<AttentionPrompt, { kind: 'NONE' }>);
      raise(win, takeFocus);
    }, delay).unref?.();
  }
}

export const attentionPresenter = {
  show(prompt: Exclude<AttentionPrompt, { kind: 'NONE' }>): void {
    current = prompt;
    ensure();
    presentCurrent(true);
  },
  hide(): void {
    presentationGeneration += 1;
    current = { kind: 'NONE' };
    publish();
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  },
  yieldToSystemSettings(prompt: Extract<AttentionPrompt, { kind: 'PERMISSION' }>): void {
    presentationGeneration += 1;
    current = prompt;
    publish();
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    win.blur();
  },
  reassert(takeFocus = false): void {
    reassertAttentionWindow(takeFocus);
  },
};

export function reassertAttentionWindow(takeFocus = false): void {
  if (!isFront(current) || !win || win.isDestroyed()) return;
  applyBounds(win, current as Exclude<AttentionPrompt, { kind: 'NONE' }>);
  raise(win, takeFocus);
}

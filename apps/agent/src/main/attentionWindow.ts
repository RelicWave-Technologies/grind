import { app, type BrowserWindow } from 'electron';
import type { AttentionPrompt } from '../shared/attention';
import {
  activeWorkArea,
  assertOverlayFloat,
  center,
  createOverlayWindow,
  topRight,
  type OverlayFloatOptions,
} from './windows/overlay';

const SIZES = {
  IDLE_WARNING: { width: 340, height: 280 },
  IDLE: { width: 340, height: 280 },
  AWAY: { width: 360, height: 222 },
  PERMISSION: { width: 480, height: 332 },
} as const;
// Fullscreen and Space transitions can settle after the first compositor pass.
// Keep recovery bounded and non-activating: the prompt stays visible without
// repeatedly stealing focus from the app the person was using.
const RAISE_RETRY_MS = [100, 400, 1000] as const;

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
    if (current.kind !== 'NONE') presentCurrent();
  });
  win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
    if (!isAlwaysOnTop && isFront(current)) {
      queueMicrotask(() => reassertAttentionWindow({ refreshWorkspaceVisibility: true }));
    }
  });
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

function raise(window: BrowserWindow, options: OverlayFloatOptions = {}): void {
  // This is a blocking attention surface. showInactive() cannot guarantee a
  // window crosses another app's fullscreen Space, while activating Timo can.
  // Keep this behavior exclusive to the coordinator-owned prompt.
  assertOverlayFloat(window, options);
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.show();
  window.moveTop();
  window.focus();
}

function presentCurrent(): void {
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
  raise(window);
  for (const delay of RAISE_RETRY_MS) {
    setTimeout(() => {
      if (generation !== presentationGeneration || !isFront(current)) return;
      if (!win || win.isDestroyed()) return;
      applyBounds(win, current as Exclude<AttentionPrompt, { kind: 'NONE' }>);
      raise(win);
    }, delay).unref?.();
  }
}

export const attentionPresenter = {
  show(prompt: Exclude<AttentionPrompt, { kind: 'NONE' }>): void {
    current = prompt;
    ensure();
    presentCurrent();
  },
  hide(): void {
    presentationGeneration += 1;
    current = { kind: 'NONE' };
    publish();
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) win.hide();
    }
  },
  yieldToSystemSettings(prompt: Extract<AttentionPrompt, { kind: 'PERMISSION' }>): void {
    presentationGeneration += 1;
    current = prompt;
    publish();
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    win.blur();
  },
  reassert(): void {
    reassertAttentionWindow();
  },
};

export function reassertAttentionWindow(options: OverlayFloatOptions = {}): void {
  if (!isFront(current) || !win || win.isDestroyed()) return;
  applyBounds(win, current as Exclude<AttentionPrompt, { kind: 'NONE' }>);
  raise(win, options);
}

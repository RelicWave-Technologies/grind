import { beforeEach, describe, it, expect, vi } from 'vitest';

let lastConstructorOptions: Record<string, unknown> | null = null;
const mocks = vi.hoisted(() => ({ setActivationPolicy: vi.fn() }));

vi.mock('electron', () => ({
  app: { setActivationPolicy: mocks.setActivationPolicy },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      lastConstructorOptions = options;
    }
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    isFocused = vi.fn(() => false);
    isAlwaysOnTop = vi.fn(() => true);
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    showInactive = vi.fn();
    moveTop = vi.fn();
    on = vi.fn();
    once = vi.fn();
    loadURL = vi.fn();
    loadFile = vi.fn();
  },
}));

import {
  ambientRaiseAllowed,
  assertOverlayFloat,
  center,
  createOverlayWindow,
  keepOnTop,
  reassertAllOverlays,
  releaseOnTop,
  topRight,
  bottomRight,
  trayPopoverPoint,
  __keeperTickForTests,
  __resetKeeperForTests,
  type Rect,
} from './overlay';

beforeEach(() => vi.clearAllMocks());

const SIZE = { width: 320, height: 168 };
const PRIMARY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
// A second monitor to the right, with a non-zero origin.
const SECOND: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('assertOverlayFloat', () => {
  it('lets Electron run its process transition, then restores the app identity', () => {
    const win = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    } as unknown as Electron.BrowserWindow;

    assertOverlayFloat(win);
    assertOverlayFloat(win);

    expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(2);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver', 0);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledOnce();
    // Skipping the transition is only valid for UIElement apps, and Timo is a
    // normal foreground app — suppressing it is why all-Spaces membership never
    // really took. Let it run, and put the Dock identity back afterwards.
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      { visibleOnFullScreen: true },
    );
    expect(mocks.setActivationPolicy).toHaveBeenCalledWith('regular');
  });

  it('asserts the always-on-top level LAST so nothing can undo it', () => {
    const order: string[] = [];
    const win = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(() => void order.push('alwaysOnTop')),
      setVisibleOnAllWorkspaces: vi.fn(() => void order.push('allWorkspaces')),
    } as unknown as Electron.BrowserWindow;

    assertOverlayFloat(win);

    // The all-workspaces call reconfigures collection behaviour and is the prime
    // suspect for silently resetting the window level. Whoever writes last wins,
    // so the level must write last — otherwise ordinary windows end up on top of
    // a screen-saver-level prompt.
    expect(order).toEqual(['allWorkspaces', 'alwaysOnTop']);
  });

  it('refreshes fullscreen-Space membership after wake or display changes', () => {
    const win = {
      isDestroyed: vi.fn(() => false),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    } as unknown as Electron.BrowserWindow;

    assertOverlayFloat(win);
    assertOverlayFloat(win, { refreshWorkspaceVisibility: true });

    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(2);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(
      true,
      { visibleOnFullScreen: true },
    );
    // Identity is restored after every transition, not just the first.
    expect(mocks.setActivationPolicy).toHaveBeenCalledTimes(2);
  });
});

/**
 * The keeper is the answer to "why does the timer bar never fall behind, and
 * everything else does". The bar re-asserted itself roughly twice a second,
 * forever; the prompt did it four times and stopped; the toast did it once.
 * Same factory, same level, same non-activating panel — only the cadence
 * differed, and exactly one of the four callers had it right.
 */
function fakeWindow(opts: { visible?: boolean; focused?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => opts.visible ?? true),
    isFocused: vi.fn(() => opts.focused ?? false),
    isAlwaysOnTop: vi.fn(() => true),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    showInactive: vi.fn(),
    moveTop: vi.fn(),
    once: vi.fn(),
  };
}

describe('overlay keeper', () => {
  beforeEach(() => __resetKeeperForTests());

  it('keeps re-raising indefinitely — there is no ladder to run out', () => {
    const win = fakeWindow();
    keepOnTop(win as unknown as Electron.BrowserWindow);
    expect(win.moveTop).toHaveBeenCalledTimes(1);

    // Well past the 1000ms ceiling where the prompt's old retry ladder gave up
    // for the rest of the session.
    for (let i = 0; i < 60; i += 1) __keeperTickForTests();

    expect(win.moveTop).toHaveBeenCalledTimes(61);
  });

  it('re-raises unconditionally, without asking whether it is still on top', () => {
    const win = fakeWindow();
    keepOnTop(win as unknown as Electron.BrowserWindow);
    __keeperTickForTests();
    __keeperTickForTests();

    // Gating on isAlwaysOnTop() cannot tell "still floating but buried" from
    // healthy. The bar never checked, and the bar is the one that worked.
    expect(win.isAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.moveTop).toHaveBeenCalledTimes(3);
  });

  it('is idempotent, so calling it from the 1 Hz tick costs nothing', () => {
    const win = fakeWindow();
    keepOnTop(win as unknown as Electron.BrowserWindow);
    keepOnTop(win as unknown as Electron.BrowserWindow);
    keepOnTop(win as unknown as Electron.BrowserWindow);

    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it('does no work for a hidden overlay', () => {
    const win = fakeWindow({ visible: false });
    keepOnTop(win as unknown as Electron.BrowserWindow);
    win.moveTop.mockClear();

    __keeperTickForTests();

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  it('stops holding on release', () => {
    const win = fakeWindow();
    keepOnTop(win as unknown as Electron.BrowserWindow);
    releaseOnTop(win as unknown as Electron.BrowserWindow);
    win.moveTop.mockClear();

    __keeperTickForTests();

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  it('refreshes workspace visibility for KEPT windows, not just registry ones', () => {
    // Regression: the attention prompt opts out of the reassert registry, and
    // the keeper's 1 Hz raise deliberately skips the all-workspaces call. So a
    // held prompt kept its always-on-top level across a sleep but silently lost
    // the collection behaviours that put it above a fullscreen app — until this.
    const prompt = createOverlayWindow({
      width: 1, height: 1, hash: 'attention', rank: 'prompt', registerForReassert: false,
    });
    keepOnTop(prompt);
    vi.mocked(prompt.setVisibleOnAllWorkspaces).mockClear();

    reassertAllOverlays();

    expect(prompt.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      { visibleOnFullScreen: true },
    );
  });

  it('never re-asserts the same overlay twice in one pass', () => {
    const win = createOverlayWindow({ width: 1, height: 1, hash: 'floating' });
    keepOnTop(win);
    vi.mocked(win.setVisibleOnAllWorkspaces).mockClear();

    // In the registry AND kept — it must not be visited once per set.
    reassertAllOverlays();

    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('does not stack a listener each time a surface is re-kept', () => {
    // The tray popover keeps on every click and releases on blur. Registering
    // the cleanup per keep leaked a listener per toggle on a window that never
    // closes — it belongs on creation, once.
    const win = createOverlayWindow({ width: 1, height: 1, hash: 'popover' });
    const onCalls = vi.mocked(win.on).mock.calls.length;

    for (let i = 0; i < 20; i += 1) {
      keepOnTop(win);
      releaseOnTop(win);
    }

    expect(vi.mocked(win.on).mock.calls.length).toBe(onCalls);
  });

  it('drops a destroyed overlay instead of calling into it', () => {
    const win = fakeWindow();
    keepOnTop(win as unknown as Electron.BrowserWindow);
    win.isDestroyed.mockReturnValue(true);
    win.moveTop.mockClear();

    __keeperTickForTests();

    expect(win.moveTop).not.toHaveBeenCalled();
  });
});

describe('overlay rank', () => {
  beforeEach(() => __resetKeeperForTests());

  it('stops an ambient overlay climbing over a held prompt', () => {
    const bar = fakeWindow();
    const prompt = createOverlayWindow({ width: 1, height: 1, hash: 'attention', rank: 'prompt' });
    keepOnTop(bar as unknown as Electron.BrowserWindow);
    expect(ambientRaiseAllowed()).toBe(true);

    keepOnTop(prompt);
    // Rank must be enforced by declining the call, not only by window level:
    // Windows collapses every always-on-top level into one topmost band, so
    // there the suppression is the ONLY thing keeping the bar off the prompt.
    expect(ambientRaiseAllowed()).toBe(false);

    bar.moveTop.mockClear();
    __keeperTickForTests();
    expect(bar.moveTop).not.toHaveBeenCalled();

    releaseOnTop(prompt);
    expect(ambientRaiseAllowed()).toBe(true);
    __keeperTickForTests();
    expect(bar.moveTop).toHaveBeenCalled();
  });

  it('gives a prompt a higher relative level than ambient on macOS', () => {
    const ambient = createOverlayWindow({ width: 1, height: 1, hash: 'floating' });
    const prompt = createOverlayWindow({ width: 1, height: 1, hash: 'attention', rank: 'prompt' });

    assertOverlayFloat(ambient);
    expect(ambient.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver', 0);

    assertOverlayFloat(prompt);
    expect(prompt.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver', 1);
  });

  it('creates every overlay already floating', () => {
    createOverlayWindow({ width: 1, height: 1, hash: 'floating' });
    // The original idle prompt set this at construction and never fell behind;
    // every rewrite since relied purely on a post-construction call.
    expect(lastConstructorOptions?.alwaysOnTop).toBe(true);
  });
});

describe('center', () => {
  it('centers on the usable area of the active display', () => {
    expect(center(SECOND, SIZE)).toEqual({
      x: Math.round(1440 + (1920 - 320) / 2),
      y: Math.round((1080 - 168) / 2),
    });
  });
});

describe('topRight', () => {
  it('pins to the top-right with the default gutter', () => {
    const p = topRight(PRIMARY, SIZE);
    expect(p.x).toBe(1440 - 320 - 16);
    expect(p.y).toBe(16);
  });

  it('lands on the secondary monitor when given its work area', () => {
    const p = topRight(SECOND, SIZE);
    expect(p.x).toBe(1440 + 1920 - 320 - 16);
    expect(p.y).toBe(16);
  });

  it('honors a custom gutter', () => {
    const p = topRight(PRIMARY, SIZE, 40);
    expect(p.x).toBe(1440 - 320 - 40);
    expect(p.y).toBe(40);
  });
});

describe('bottomRight', () => {
  it('pins to the bottom-right with the default gutter', () => {
    const p = bottomRight(PRIMARY, SIZE);
    expect(p.x).toBe(1440 - 320 - 20);
    expect(p.y).toBe(900 - 168 - 20);
  });

  it('accounts for a macOS menu-bar / dock inset (non-zero y origin)', () => {
    const inset: Rect = { x: 0, y: 25, width: 1440, height: 850 };
    const p = bottomRight(inset, SIZE);
    expect(p.y).toBe(25 + 850 - 168 - 20);
  });
});

describe('trayPopoverPoint', () => {
  const POPOVER = { width: 300, height: 340 };

  it('opens below a macOS-style top menu bar tray icon', () => {
    const wa: Rect = { x: 0, y: 25, width: 1440, height: 875 };
    const tray: Rect = { x: 1180, y: 0, width: 24, height: 24 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.y).toBe(31);
    expect(p.x).toBe(Math.round(1180 + 12 - 150));
  });

  it('opens above a Windows bottom taskbar tray icon', () => {
    const wa: Rect = { x: 0, y: 0, width: 1440, height: 860 };
    const tray: Rect = { x: 1320, y: 860, width: 24, height: 40 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.y).toBe(860 - 340 - 6);
    expect(p.x).toBe(1440 - 300 - 6);
  });

  it('keeps the popover inside a small work area', () => {
    const wa: Rect = { x: 100, y: 50, width: 320, height: 360 };
    const tray: Rect = { x: 390, y: 390, width: 24, height: 24 };
    const p = trayPopoverPoint(tray, wa, POPOVER);

    expect(p.x).toBe(114);
    expect(p.y).toBe(56);
  });
});

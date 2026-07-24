import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const webListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    webContents: { on: vi.fn((event: string, cb: (...args: unknown[]) => void) => webListeners.set(event, cb)), send: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => windowListeners.set(event, cb)),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    flashFrame: vi.fn(),
  };
  return {
    webListeners,
    windowListeners,
    window,
    create: vi.fn(() => window),
    assertFloat: vi.fn(),
    appFocus: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: { focus: mocks.appFocus } }));
vi.mock('./windows/overlay', () => ({
  createOverlayWindow: mocks.create,
  assertOverlayFloat: mocks.assertFloat,
  activeWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  center: () => ({ x: 480, y: 284 }),
  topRight: () => ({ x: 1104, y: 16 }),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

describe('attention window', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.webListeners.clear();
    mocks.windowListeners.clear();
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.window.isVisible.mockReturnValue(false);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reuses one physical BrowserWindow across prompt kinds', async () => {
    setPlatform('win32');
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();
    attentionPresenter.show({ kind: 'AWAY', promptId: 'away-1', larkTaskGuid: null, stoppedAt: 200, reason: 'lock' });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      hash: 'attention',
      registerForReassert: false,
    }));
    expect(mocks.window.setBounds).toHaveBeenLastCalledWith(
      { x: 1104, y: 16, width: 360, height: 222 },
      false,
    );
    expect(mocks.window.show).toHaveBeenCalled();
    expect(mocks.window.focus).toHaveBeenCalled();
  });

  it('does not float or steal focus again after yielding to System Settings', async () => {
    const { attentionPresenter, reassertAttentionWindow } = await import('./attentionWindow');
    const front = { kind: 'PERMISSION' as const, promptId: 'permission-1', intent: 'START_TASK' as const, presentation: 'FRONT' as const };
    attentionPresenter.show(front);
    mocks.webListeners.get('did-finish-load')?.();
    attentionPresenter.yieldToSystemSettings({ ...front, presentation: 'YIELDED_TO_SETTINGS' });
    const floatCalls = mocks.assertFloat.mock.calls.length;
    const showCalls = mocks.window.show.mock.calls.length;
    const focusCalls = mocks.window.focus.mock.calls.length;
    const appFocusCalls = mocks.appFocus.mock.calls.length;

    reassertAttentionWindow();
    vi.runAllTimers();

    expect(mocks.window.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(mocks.window.blur).toHaveBeenCalled();
    expect(mocks.assertFloat).toHaveBeenCalledTimes(floatCalls);
    expect(mocks.window.show).toHaveBeenCalledTimes(showCalls);
    expect(mocks.window.focus).toHaveBeenCalledTimes(focusCalls);
    expect(mocks.appFocus).toHaveBeenCalledTimes(appFocusCalls);
  });

  it('presents permission in front until it yields to System Settings', async () => {
    setPlatform('win32');
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({
      kind: 'PERMISSION',
      promptId: 'permission-1',
      intent: 'START_TASK',
      presentation: 'FRONT',
    });
    mocks.webListeners.get('did-finish-load')?.();

    expect(mocks.assertFloat).toHaveBeenCalledWith(mocks.window, {});
    expect(mocks.window.show).toHaveBeenCalled();
    expect(mocks.window.focus).toHaveBeenCalled();
  });

  it('refreshes fullscreen-Space membership and restores attention', async () => {
    const { attentionPresenter, reassertAttentionWindow } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'AWAY', promptId: 'away-1', larkTaskGuid: null, stoppedAt: 200, reason: 'lock' });
    mocks.webListeners.get('did-finish-load')?.();
    vi.clearAllMocks();

    reassertAttentionWindow({ refreshWorkspaceVisibility: true });

    expect(mocks.assertFloat).toHaveBeenCalledWith(
      mocks.window,
      { refreshWorkspaceVisibility: true },
    );
    expect(mocks.window.moveTop).toHaveBeenCalled();
    expect(mocks.window.focus).toHaveBeenCalled();
  });

  it('uses only bounded retries while a prompt is frontmost', async () => {
    setPlatform('win32');
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();
    vi.clearAllMocks();

    vi.advanceTimersByTime(999);
    expect(mocks.assertFloat).toHaveBeenCalledTimes(2);
    expect(mocks.window.show).toHaveBeenCalledTimes(2);
    expect(mocks.window.focus).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect(mocks.assertFloat).toHaveBeenCalledTimes(3);
    expect(mocks.window.show).toHaveBeenCalledTimes(3);
    expect(mocks.window.focus).toHaveBeenCalledTimes(3);
  });

  it('presents on the current Space without activating Timo on macOS', async () => {
    setPlatform('darwin');
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();

    // Activating the app (or an activating show) would make macOS switch
    // Spaces and yank the user out of their fullscreen app. The panel is
    // shown inactive on the current Space and made key without activation.
    expect(mocks.appFocus).not.toHaveBeenCalled();
    expect(mocks.window.show).not.toHaveBeenCalled();
    expect(mocks.window.showInactive).toHaveBeenCalled();
    expect(mocks.window.moveTop).toHaveBeenCalled();
    expect(mocks.window.focus).toHaveBeenCalled();
  });
});

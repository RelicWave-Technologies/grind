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
    enterFullscreen: vi.fn(),
    leaveFullscreen: vi.fn(),
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
vi.mock('./windows/macAppIdentity', () => ({
  enterMacFullscreenAttention: mocks.enterFullscreen,
  leaveMacFullscreenAttention: mocks.leaveFullscreen,
}));

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
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reuses one physical BrowserWindow across prompt kinds', async () => {
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();
    attentionPresenter.show({ kind: 'AWAY', promptId: 'away-1', larkTaskGuid: null, stoppedAt: 200, reason: 'lock' });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      hash: 'attention',
      activation: 'interactive',
      registerForReassert: false,
    }));
    expect(mocks.window.setBounds).toHaveBeenLastCalledWith(
      { x: 1104, y: 16, width: 360, height: 222 },
      false,
    );
    expect(mocks.window.showInactive).toHaveBeenCalled();
    expect(mocks.window.show).not.toHaveBeenCalled();
    expect(mocks.window.focus).not.toHaveBeenCalled();
    expect(mocks.appFocus).not.toHaveBeenCalled();
  });

  it('does not float or steal focus again after yielding to System Settings', async () => {
    const { attentionPresenter, reassertAttentionWindow } = await import('./attentionWindow');
    const front = { kind: 'PERMISSION' as const, promptId: 'permission-1', intent: 'START_TASK' as const, presentation: 'FRONT' as const };
    attentionPresenter.show(front);
    mocks.webListeners.get('did-finish-load')?.();
    attentionPresenter.yieldToSystemSettings({ ...front, presentation: 'YIELDED_TO_SETTINGS' });
    const floatCalls = mocks.assertFloat.mock.calls.length;
    const inactiveShowCalls = mocks.window.showInactive.mock.calls.length;

    reassertAttentionWindow();
    vi.runAllTimers();

    expect(mocks.window.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(mocks.window.blur).toHaveBeenCalled();
    expect(mocks.assertFloat).toHaveBeenCalledTimes(floatCalls);
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(inactiveShowCalls);
    expect(mocks.window.focus).not.toHaveBeenCalled();
    expect(mocks.appFocus).not.toHaveBeenCalled();
  });

  it('keeps permission presentation in the regular app process', async () => {
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({
      kind: 'PERMISSION',
      promptId: 'permission-1',
      intent: 'START_TASK',
      presentation: 'FRONT',
    });
    mocks.webListeners.get('did-finish-load')?.();

    expect(mocks.assertFloat).toHaveBeenCalledWith(mocks.window, {});
    expect(mocks.enterFullscreen).not.toHaveBeenCalled();
    expect(mocks.leaveFullscreen).toHaveBeenCalledWith(mocks.window);
  });

  it('refreshes fullscreen-Space membership without taking focus', async () => {
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
    expect(mocks.window.focus).not.toHaveBeenCalled();
    expect(mocks.appFocus).not.toHaveBeenCalled();
  });

  it('uses only bounded non-activating retries while a prompt is frontmost', async () => {
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();
    vi.clearAllMocks();

    vi.advanceTimersByTime(999);
    expect(mocks.assertFloat).toHaveBeenCalledTimes(2);
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(2);
    expect(mocks.window.focus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mocks.assertFloat).toHaveBeenCalledTimes(3);
    expect(mocks.window.showInactive).toHaveBeenCalledTimes(3);
    expect(mocks.window.focus).not.toHaveBeenCalled();
  });

  it('acquires fullscreen attention once before bounded raises', async () => {
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });
    mocks.webListeners.get('did-finish-load')?.();

    vi.runAllTimers();

    expect(mocks.enterFullscreen).toHaveBeenCalledTimes(1);
    expect(mocks.enterFullscreen).toHaveBeenCalledWith(mocks.window);
    expect(mocks.leaveFullscreen).not.toHaveBeenCalled();
  });

  it('releases fullscreen attention when the prompt is hidden', async () => {
    const { attentionPresenter } = await import('./attentionWindow');
    attentionPresenter.show({ kind: 'AWAY', promptId: 'away-1', larkTaskGuid: null, stoppedAt: 200, reason: 'lock' });
    mocks.webListeners.get('did-finish-load')?.();

    attentionPresenter.hide();

    expect(mocks.leaveFullscreen).toHaveBeenCalledWith(mocks.window);
  });
});

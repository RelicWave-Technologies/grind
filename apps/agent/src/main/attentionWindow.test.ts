import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const webListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    webContents: { on: vi.fn((event: string, cb: (...args: unknown[]) => void) => webListeners.set(event, cb)), send: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => windowListeners.set(event, cb)),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
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
      { x: 1104, y: 16, width: 320, height: 176 },
      false,
    );
  });

  it('does not float or steal focus again after yielding to System Settings', async () => {
    const { attentionPresenter, reassertAttentionWindow } = await import('./attentionWindow');
    const front = { kind: 'PERMISSION' as const, promptId: 'permission-1', intent: 'START_TASK' as const, presentation: 'FRONT' as const };
    attentionPresenter.show(front);
    mocks.webListeners.get('did-finish-load')?.();
    attentionPresenter.yieldToSystemSettings({ ...front, presentation: 'YIELDED_TO_SETTINGS' });
    const floatCalls = mocks.assertFloat.mock.calls.length;
    const focusCalls = mocks.window.focus.mock.calls.length;

    reassertAttentionWindow(true);
    vi.runAllTimers();

    expect(mocks.window.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(mocks.window.blur).toHaveBeenCalled();
    expect(mocks.assertFloat).toHaveBeenCalledTimes(floatCalls);
    expect(mocks.window.focus).toHaveBeenCalledTimes(focusCalls);
  });
});

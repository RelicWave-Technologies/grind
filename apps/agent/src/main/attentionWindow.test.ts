import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const webListeners = new Map<string, (...args: unknown[]) => void>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isAlwaysOnTop: vi.fn(() => true),
    webContents: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => webListeners.set(event, cb)),
      send: vi.fn(),
    },
    on: vi.fn(),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
  };
  return {
    webListeners,
    window,
    create: vi.fn(() => window),
    keepOnTop: vi.fn(),
    releaseOnTop: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: { focus: vi.fn() } }));
vi.mock('./logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('./windows/overlay', () => ({
  createOverlayWindow: mocks.create,
  keepOnTop: mocks.keepOnTop,
  releaseOnTop: mocks.releaseOnTop,
  activeWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  center: () => ({ x: 480, y: 284 }),
  topRight: () => ({ x: 1104, y: 16 }),
}));

describe('attention overlay host', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.webListeners.clear();
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.window.isVisible.mockReturnValue(true);
    mocks.window.isAlwaysOnTop.mockReturnValue(true);
  });

  it('creates the surface at prompt rank, outside the global reassert registry', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      hash: 'attention',
      rank: 'prompt',
      registerForReassert: false,
    }));
  });

  it('never takes focus — on either platform', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();
    attentionHost.keep();

    // Electron's macOS focus() asks the app to activate, which is what made the
    // prompt flash to the front and drop straight back.
    expect(mocks.window.focus).not.toHaveBeenCalled();
  });

  it('hands the surface to the shared keeper rather than raising it itself', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();

    // Every overlay in the app now uses one cadence — the timer bar's, which is
    // the only one that never fell behind.
    expect(mocks.keepOnTop).toHaveBeenCalledWith(mocks.window);

    attentionHost.release();
    expect(mocks.releaseOnTop).toHaveBeenCalledWith(mocks.window);
  });

  it('reports having lost the top when the always-on-top level is gone', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();
    expect(attentionHost.onTop()).toBe(true);

    // Exactly the reported failure: the surface is still there and still in
    // place, but ordinary windows are now above it.
    mocks.window.isAlwaysOnTop.mockReturnValue(false);

    expect(attentionHost.onTop()).toBe(false);
  });

  it('reports having lost the top when the surface is hidden', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();
    mocks.window.isVisible.mockReturnValue(false);

    expect(attentionHost.onTop()).toBe(false);
  });

  it('places where it is told without consulting a cached prompt', async () => {
    const { attentionHost } = await import('./attentionWindow');

    attentionHost.place({ width: 360, height: 222, placement: 'topRight' });
    expect(mocks.window.setBounds).toHaveBeenLastCalledWith(
      { x: 1104, y: 16, width: 360, height: 222 },
      false,
    );

    attentionHost.place({ width: 480, height: 332, placement: 'center' });
    expect(mocks.window.setBounds).toHaveBeenLastCalledWith(
      { x: 480, y: 284, width: 480, height: 332 },
      false,
    );
  });

  it('stands down without hiding when lowered', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.keep();
    attentionHost.lower();

    expect(mocks.window.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(mocks.window.blur).toHaveBeenCalled();
    expect(mocks.window.hide).not.toHaveBeenCalled();
  });

  it('publishes prompt state passed in, holding none of its own', async () => {
    const { attentionHost } = await import('./attentionWindow');
    attentionHost.onReady(() => {});
    mocks.webListeners.get('did-finish-load')?.();

    attentionHost.publish({ kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 });

    expect(mocks.window.webContents.send).toHaveBeenCalledWith(
      'attention:state:push',
      { kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 },
    );
  });
});

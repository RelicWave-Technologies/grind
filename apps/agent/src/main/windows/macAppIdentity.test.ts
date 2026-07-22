import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActivationPolicy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { setActivationPolicy: mocks.setActivationPolicy },
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.clearAllMocks();
  vi.resetModules();
});

describe('ensureRegularMacApplication', () => {
  it('keeps the macOS host process as a normal Dock and Cmd+Tab app', async () => {
    setPlatform('darwin');
    const { ensureRegularMacApplication } = await import('./macAppIdentity');

    ensureRegularMacApplication();

    expect(mocks.setActivationPolicy).toHaveBeenCalledWith('regular');
  });

  it('does not invoke a macOS API on other platforms', async () => {
    setPlatform('win32');
    const { ensureRegularMacApplication } = await import('./macAppIdentity');

    ensureRegularMacApplication();

    expect(mocks.setActivationPolicy).not.toHaveBeenCalled();
  });

  it('acquires one process-wide fullscreen attention lease idempotently', async () => {
    setPlatform('darwin');
    const { enterMacFullscreenAttention } = await import('./macAppIdentity');
    const window = {
      isDestroyed: vi.fn(() => false),
      setVisibleOnAllWorkspaces: vi.fn(),
    } as unknown as Electron.BrowserWindow;

    enterMacFullscreenAttention(window);
    enterMacFullscreenAttention(window);

    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledOnce();
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      { visibleOnFullScreen: true },
    );
  });

  it('restores normal app identity once when the attention lease ends', async () => {
    setPlatform('darwin');
    const { enterMacFullscreenAttention, leaveMacFullscreenAttention } = await import('./macAppIdentity');
    const window = {
      isDestroyed: vi.fn(() => false),
      setVisibleOnAllWorkspaces: vi.fn(),
    } as unknown as Electron.BrowserWindow;

    enterMacFullscreenAttention(window);
    leaveMacFullscreenAttention(window);
    leaveMacFullscreenAttention(window);

    expect(mocks.setActivationPolicy).toHaveBeenCalledOnce();
    expect(mocks.setActivationPolicy).toHaveBeenCalledWith('regular');
  });
});

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

});

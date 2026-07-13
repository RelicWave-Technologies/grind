import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Tray: class Tray {},
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createEmpty: vi.fn() },
  app: { getAppPath: vi.fn(), getPath: vi.fn(), isPackaged: false },
}));

const { trayGuidForPlatform } = await import('./tray');

describe('trayGuidForPlatform', () => {
  it('does not pass a GUID on unsigned Windows builds', () => {
    expect(trayGuidForPlatform('win32')).toBeUndefined();
  });

  it('uses a UUID-shaped GUID on macOS', () => {
    expect(trayGuidForPlatform('darwin', false)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('keeps local dev separate from the installed Timo status item on macOS', () => {
    expect(trayGuidForPlatform('darwin', true)).not.toBe(
      trayGuidForPlatform('darwin', false),
    );
  });
});

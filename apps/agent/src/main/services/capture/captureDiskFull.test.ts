import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  warn: vi.fn(),
}));

const frame = () => ({
  id: 'screen:1',
  display_id: '1',
  thumbnail: {
    isEmpty: () => false,
    getSize: () => ({ width: 2, height: 2 }),
    toBitmap: () => Buffer.alloc(16, 200),
  },
});

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => [frame(), frame()]) },
  screen: { getAllDisplays: () => [{}, {}] },
  app: { getPath: () => '/tmp/timo-disk-full-test' },
}));
vi.mock('node:fs', () => ({
  promises: { mkdir: mocks.mkdir, writeFile: mocks.writeFile, unlink: mocks.unlink, readFile: vi.fn() },
}));
vi.mock('../permissions', () => ({ hasScreenAccess: () => true }));
vi.mock('../serverClock', () => ({ serverAlignedNow: () => 1_760_000_000_000 }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: mocks.warn, debug: vi.fn(), error: vi.fn() } }));

const { captureNow, isDiskFullError } = await import('./capture');

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

describe('capturing onto a full disk', () => {
  beforeEach(() => {
    mocks.mkdir.mockReset().mockResolvedValue(undefined);
    mocks.writeFile.mockReset();
    mocks.unlink.mockReset().mockResolvedValue(undefined);
    mocks.warn.mockReset();
  });

  it('recognises out-of-space errors from the file system and from SQLite', () => {
    expect(isDiskFullError(enospc())).toBe(true);
    expect(isDiskFullError(Object.assign(new Error('quota'), { code: 'EDQUOT' }))).toBe(true);
    expect(isDiskFullError(Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }))).toBe(true);
    expect(isDiskFullError(new Error('EACCES'))).toBe(false);
  });

  it('reports disk full instead of throwing, removes the partial file, and keeps screen health ok', async () => {
    mocks.writeFile.mockRejectedValue(enospc());

    const result = await captureNow('entry-1');

    expect(result).toEqual({ rows: [], health: 'ok', diskFull: true });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1); // stops at the first display
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith('screenshot not stored: disk full', expect.anything());
  });

  it('reports disk full when even the day folder cannot be created', async () => {
    mocks.mkdir.mockRejectedValue(enospc());
    await expect(captureNow('entry-1')).resolves.toEqual({ rows: [], health: 'ok', diskFull: true });
  });

  it('still throws anything that is not a full disk', async () => {
    mocks.writeFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(captureNow('entry-1')).rejects.toThrow('EACCES');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  hasScreenAccess: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: { getAllDisplays: () => [] },
  app: { getPath: () => '/tmp/timo-probe-test' },
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    readFile: vi.fn(),
  },
}));

vi.mock('../permissions', () => ({
  hasScreenAccess: mocks.hasScreenAccess,
}));

import { probeScreenCapture } from './capture';

describe('probeScreenCapture', () => {
  beforeEach(() => {
    mocks.getSources.mockReset();
    mocks.mkdir.mockReset();
    mocks.writeFile.mockReset();
    mocks.hasScreenAccess.mockReturnValue(true);
  });

  it('verifies a usable frame without writing or retaining screenshot files', async () => {
    mocks.getSources.mockResolvedValue([{ thumbnail: { isEmpty: () => false } }]);

    await expect(probeScreenCapture()).resolves.toBe('ok');

    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 64, height: 64 },
      fetchWindowIcons: false,
    });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('reports missing permission without touching disk', async () => {
    mocks.hasScreenAccess.mockReturnValue(false);
    mocks.getSources.mockRejectedValue(new Error('not allowed'));

    await expect(probeScreenCapture()).resolves.toBe('no-permission');
    expect(mocks.getSources).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  describe('retries', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const blank = [{ thumbnail: { isEmpty: () => true } }];
    const frame = [{ thumbnail: { isEmpty: () => false } }];

    it('retries a blank first reading with backoff and reports the recovery', async () => {
      mocks.getSources
        .mockResolvedValueOnce(blank)
        .mockResolvedValueOnce(blank)
        .mockResolvedValueOnce(frame);

      const result = probeScreenCapture();
      await vi.advanceTimersByTimeAsync(499);
      expect(mocks.getSources).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.getSources).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('ok');
      expect(mocks.getSources).toHaveBeenCalledTimes(3);
    });

    it('gives up after three attempts and reports what it saw', async () => {
      mocks.getSources.mockResolvedValue(blank);

      const result = probeScreenCapture();
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(result).resolves.toBe('empty');
      expect(mocks.getSources).toHaveBeenCalledTimes(3);
    });

    it('stops at the first usable frame', async () => {
      mocks.getSources.mockResolvedValue(frame);

      await expect(probeScreenCapture()).resolves.toBe('ok');
      expect(mocks.getSources).toHaveBeenCalledTimes(1);
    });

    it('does not retry without a grant', async () => {
      mocks.hasScreenAccess.mockReturnValue(false);
      mocks.getSources.mockResolvedValue(blank);

      await expect(probeScreenCapture()).resolves.toBe('empty');
      expect(mocks.getSources).toHaveBeenCalledTimes(1);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});

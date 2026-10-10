import { describe, expect, it, vi } from 'vitest';
import { createTimeEntry } from '@grind/core';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.2-beta.38' } }));
vi.mock('../apiClient', () => ({ api: mocks.api }));

import { HttpSyncClient } from './syncClient';

describe('HttpSyncClient.create', () => {
  it('stamps the packaged app version and platform on the entry, not the npm launcher variable', async () => {
    vi.stubEnv('npm_package_version', '');
    mocks.api.mockRejectedValue(new Error('stop here'));
    const entry = createTimeEntry({
      id: 'e1',
      clientUuid: 'c1',
      userId: 'u1',
      source: 'AUTO',
      startedAt: Date.UTC(2026, 9, 10),
      segmentId: 's1',
    });

    await expect(new HttpSyncClient().create(entry)).rejects.toThrow('stop here');

    expect(mocks.api).toHaveBeenCalledWith('/v1/time-entries', expect.objectContaining({
      body: expect.objectContaining({
        agentVersion: '0.0.2-beta.38',
        platform: expect.stringMatching(/^(darwin|win32|linux)$/),
      }),
    }));
    vi.unstubAllEnvs();
  });
});

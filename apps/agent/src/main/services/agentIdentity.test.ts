import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getVersion: vi.fn(() => '0.0.2-beta.38') }));
vi.mock('electron', () => ({ app: { getVersion: mocks.getVersion } }));

import { agentVersion, currentPlatform } from './agentIdentity';

describe('agentVersion', () => {
  it('reports the packaged app version, not the npm launcher variable', () => {
    vi.stubEnv('npm_package_version', '');
    expect(agentVersion()).toBe('0.0.2-beta.38');
    vi.unstubAllEnvs();
  });

  it('never reports a plausible-looking fake version when Electron cannot answer', () => {
    mocks.getVersion.mockImplementationOnce(() => {
      throw new Error('app not ready');
    });
    expect(agentVersion()).toBe('0.0.0-unknown');
  });
});

describe('currentPlatform', () => {
  it('normalizes unknown node platforms to linux', () => {
    expect(currentPlatform('darwin')).toBe('darwin');
    expect(currentPlatform('win32')).toBe('win32');
    expect(currentPlatform('freebsd')).toBe('linux');
  });
});

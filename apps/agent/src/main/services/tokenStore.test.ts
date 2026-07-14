import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData = '';

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { clearTokensIfMatch, loadTokens, replaceTokensIfMatch, saveTokens } = await import('./tokenStore');

const first = { accessToken: 'a1', refreshToken: 'r1', userId: 'u', workspaceId: 'w' };
const second = { accessToken: 'a2', refreshToken: 'r2', userId: 'u', workspaceId: 'w' };

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'timo-token-store-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(userData, { recursive: true, force: true });
});

describe('tokenStore', () => {
  it('serializes concurrent replacements and exposes the newest durable tokens', async () => {
    await Promise.all([saveTokens(first), saveTokens(second)]);
    await expect(loadTokens()).resolves.toEqual(second);
  });

  it('retries a transient Windows-style destination lock without deleting the old file', async () => {
    await saveTokens(first);
    const rename = fs.rename.bind(fs);
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
    const spy = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(locked)
      .mockImplementation(rename);

    await saveTokens(second);

    expect(spy).toHaveBeenCalledTimes(2);
    await expect(loadTokens()).resolves.toEqual(second);
  });

  it('cannot clear a newer rotation using an older rejected snapshot', async () => {
    await saveTokens(second);
    await expect(clearTokensIfMatch(first)).resolves.toBe(false);
    await expect(loadTokens()).resolves.toEqual(second);
  });

  it('cannot resurrect an old session after a newer login wins', async () => {
    await saveTokens(second);
    await expect(replaceTokensIfMatch(first, { ...first, accessToken: 'late', refreshToken: 'late' })).resolves.toBe(false);
    await expect(loadTokens()).resolves.toEqual(second);
  });

  it('recovers the newest durable next slot after a locked canonical replacement', async () => {
    await saveTokens(first);
    const nextPath = path.join(userData, 'tokens.bin.recovery.next');
    await fs.writeFile(nextPath, JSON.stringify(second), { mode: 0o600 });
    const future = new Date(Date.now() + 1000);
    await fs.utimes(nextPath, future, future);

    await expect(loadTokens()).resolves.toEqual(second);
  });
});

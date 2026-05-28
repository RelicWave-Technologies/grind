import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  workspaceId: string;
};

function filePath(): string {
  return path.join(app.getPath('userData'), 'tokens.bin');
}

export async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const buf = await fs.readFile(filePath());
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('safeStorage encryption not available; clearing tokens');
      await clearTokens();
      return null;
    }
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json) as StoredTokens;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.error('failed to read tokens', { err: String(err) });
    return null;
  }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable on this OS');
  }
  const buf = safeStorage.encryptString(JSON.stringify(tokens));
  await fs.writeFile(filePath(), buf, { mode: 0o600 });
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(filePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to delete token file', { err: String(err) });
    }
  }
}

export type { StoredTokens };

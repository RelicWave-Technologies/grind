import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

export type StoredPendingLarkLogin = {
  verifier: string;
  loginUrl: string;
  createdAt: number;
};

function filePath(): string {
  return path.join(app.getPath('userData'), 'pending-lark-login.bin');
}

function coerce(raw: unknown): StoredPendingLarkLogin | null {
  const value = raw as Partial<StoredPendingLarkLogin> | null;
  if (!value) return null;
  if (typeof value.verifier !== 'string' || !value.verifier) return null;
  if (typeof value.loginUrl !== 'string' || !value.loginUrl) return null;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null;
  return { verifier: value.verifier, loginUrl: value.loginUrl, createdAt: value.createdAt };
}

export async function loadPendingLarkLogin(): Promise<StoredPendingLarkLogin | null> {
  try {
    const buf = await fs.readFile(filePath());
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('pending lark login: safeStorage unavailable; clearing');
      await clearStoredPendingLarkLogin();
      return null;
    }
    return coerce(JSON.parse(safeStorage.decryptString(buf)));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('pending lark login: unreadable, clearing', { err: String(err) });
    await clearStoredPendingLarkLogin();
    return null;
  }
}

export async function savePendingLarkLogin(login: StoredPendingLarkLogin): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable on this OS');
  }
  const buf = safeStorage.encryptString(JSON.stringify(login));
  await fs.writeFile(filePath(), buf, { mode: 0o600 });
}

export async function clearStoredPendingLarkLogin(): Promise<void> {
  try {
    await fs.unlink(filePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('pending lark login: delete failed', { err: String(err) });
    }
  }
}

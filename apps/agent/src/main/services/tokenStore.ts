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

const TRANSIENT_REPLACE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);
const REPLACE_BACKOFF_MS = [25, 50, 100, 200, 400];
let mutationChain: Promise<void> = Promise.resolve();
let tempSequence = 0;

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(operation, operation);
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredTokens>;
  return [candidate.accessToken, candidate.refreshToken, candidate.userId, candidate.workspaceId]
    .every((part) => typeof part === 'string' && part.length > 0);
}

async function tokenCandidates(): Promise<string[]> {
  const dest = filePath();
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  try {
    const names = await fs.readdir(dir);
    const candidates = names
      .filter((name) => name === base || (name.startsWith(`${base}.`) && name.endsWith('.next')))
      .map((name) => path.join(dir, name));
    const dated = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      modifiedAt: (await fs.stat(candidate)).mtimeMs,
    })));
    return dated.sort((a, b) => b.modifiedAt - a.modifiedAt).map(({ candidate }) => candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readTokens(): Promise<StoredTokens | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage encryption not available; tokens cannot be read');
    return null;
  }
  for (const candidate of await tokenCandidates()) {
    try {
      const parsed: unknown = JSON.parse(safeStorage.decryptString(await fs.readFile(candidate)));
      if (!isStoredTokens(parsed)) throw new Error('invalid_token_payload');
      return parsed;
    } catch (err) {
      log.error('failed to read token candidate', { file: path.basename(candidate), err: String(err) });
    }
  }
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replaceWithRetry(tmp: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const delay = REPLACE_BACKOFF_MS[attempt];
      if (!TRANSIENT_REPLACE_ERRORS.has(code) || delay === undefined) throw err;
      await wait(delay);
    }
  }
}

async function removeTokenFiles(): Promise<void> {
  const candidates = await tokenCandidates();
  await Promise.all(candidates.map(async (candidate) => {
    try {
      await fs.unlink(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }));
}

export async function loadTokens(): Promise<StoredTokens | null> {
  await mutationChain;
  return readTokens();
}

async function writeTokens(tokens: StoredTokens): Promise<void> {
  if (!isStoredTokens(tokens)) throw new Error('invalid_token_payload');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable on this OS');
  }
  const buf = safeStorage.encryptString(JSON.stringify(tokens));
  const dest = filePath();
  tempSequence += 1;
  const tmp = `${dest}.${process.pid}.${tempSequence}.next`;
  try {
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    // The old encrypted file remains intact until this replacement succeeds.
    // This matters on Windows where antivirus/indexing can transiently lock
    // the destination and make rename report EPERM/EBUSY.
    try {
      await replaceWithRetry(tmp, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_REPLACE_ERRORS.has(code)) throw err;
      // The fully-written encrypted `.next` file is itself a durable slot.
      // Readers choose the newest valid slot, so a persistently locked
      // canonical file cannot strand a freshly rotated Windows session.
      log.warn('canonical token replace remained locked; using durable next slot', { code });
      return;
    }
    await Promise.all((await tokenCandidates()).map(async (candidate) => {
      if (candidate === dest) return;
      await fs.unlink(candidate).catch(() => undefined);
    }));
  } catch (err) {
    void fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function sameTokens(a: StoredTokens | null, b: StoredTokens): boolean {
  return Boolean(
    a
      && a.accessToken === b.accessToken
      && a.refreshToken === b.refreshToken
      && a.userId === b.userId
      && a.workspaceId === b.workspaceId,
  );
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  return enqueueMutation(() => writeTokens(tokens));
}

/** Rotate only the session snapshot that initiated the refresh. Logout or a
 * newer login wins the race and cannot be overwritten by an older request. */
export async function replaceTokensIfMatch(expected: StoredTokens, next: StoredTokens): Promise<boolean> {
  return enqueueMutation(async () => {
    if (!sameTokens(await readTokens(), expected)) return false;
    await writeTokens(next);
    return true;
  });
}

export async function clearTokens(): Promise<void> {
  return enqueueMutation(async () => {
    try {
      await removeTokenFiles();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('failed to delete token file', { err: String(err) });
      }
    }
  });
}

/** Delete only the exact rejected session. A stale request must never erase a
 * newer login or a token rotation that reached disk while it was in flight. */
export async function clearTokensIfMatch(expected: StoredTokens): Promise<boolean> {
  return enqueueMutation(async () => {
    const current = await readTokens();
    if (!sameTokens(current, expected)) return false;
    try {
      await removeTokenFiles();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return true;
  });
}

export type { StoredTokens };

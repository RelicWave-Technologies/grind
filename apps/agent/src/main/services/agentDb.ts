import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { log } from '../logger';
import { showNotification } from '../notifications';

/**
 * The one way to open `userData/agent.db`.
 *
 * Every store used to open its own connection with its own (mostly default)
 * settings: only the timer's waited on a lock or chose a sync mode, and a
 * corrupt file surfaced as an exception deep inside whichever feature touched
 * it first — swallowed by a catch, so the app just quietly stopped working.
 *
 * Now the whole process shares ONE connection, opened here. better-sqlite3 is
 * synchronous and the main process is a single thread, so one connection never
 * contends with itself: no SQLITE_BUSY between our own stores, and one place
 * for the pragmas. It is set up with WAL, a busy timeout (for the rare outside
 * reader), and synchronous=FULL: the timer's entries are the record of paid
 * time and must survive a power cut, not just an app crash (NORMAL under WAL
 * can lose the last commits to one). A connection has a single sync mode, so
 * every store gets FULL; the write rate (a few rows a minute) makes the extra
 * fsync cheap.
 *
 * It is checked with `quick_check` before anyone uses it. A file that is not a
 * database or fails the check is moved aside — together with its -wal and
 * -shm — and a fresh one is created, and the person is told. The moved files
 * are kept for support; nothing is deleted. Boot opens it before anything
 * else touches the file, so on Windows no other handle can block the rename.
 */
export const AGENT_DB_BUSY_TIMEOUT_MS = 5_000;

const CORRUPTION_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CORRUPT_INDEX', 'SQLITE_CORRUPT_SEQUENCE', 'SQLITE_CORRUPT_VTAB']);

type FsLike = Pick<typeof fs, 'existsSync' | 'renameSync' | 'mkdirSync' | 'copyFileSync' | 'rmSync'>;

export interface OpenAgentDbDeps {
  open(file: string): Database.Database;
  fs: FsLike;
  /** Device clock, for the name of the moved-aside files. */
  now(): number;
  log: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void };
  notifyReset(): void;
}

export class AgentDbCorruptError extends Error {
  constructor(detail: string) {
    super(`agent.db failed its integrity check: ${detail}`);
  }
}

function isCorruption(err: unknown): boolean {
  if (err instanceof AgentDbCorruptError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CORRUPTION_CODES.has(code);
}

function configure(db: Database.Database): void {
  db.pragma(`busy_timeout = ${AGENT_DB_BUSY_TIMEOUT_MS}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
}

function check(db: Database.Database, deps: OpenAgentDbDeps): void {
  let result: unknown;
  try {
    result = db.pragma('quick_check', { simple: true });
  } catch (err) {
    // Still locked after the busy timeout is not damage; carry on with it.
    if ((err as { code?: unknown } | null)?.code === 'SQLITE_BUSY') {
      deps.log.warn('agent db quick_check skipped: database busy', { err: String(err) });
      return;
    }
    throw err;
  }
  if (result !== 'ok') throw new AgentDbCorruptError(String(result).slice(0, 200));
}

function asideName(file: string, deps: OpenAgentDbDeps, suffix: string): string {
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
  return `${file}.corrupt-${stamp}${suffix}`;
}

/**
 * Copy the WAL/SHM side files aside while the broken connection is still
 * open: closing it lets SQLite checkpoint or delete them, and they may hold
 * the newest writes.
 */
function copySideFilesAside(file: string, deps: OpenAgentDbDeps): string[] {
  const copied: string[] = [];
  for (const suffix of ['-wal', '-shm']) {
    const from = `${file}${suffix}`;
    try {
      if (!deps.fs.existsSync(from)) continue;
      const to = asideName(file, deps, suffix);
      deps.fs.copyFileSync(from, to);
      copied.push(to);
    } catch {
      // Best-effort evidence; the reset itself must still happen.
    }
  }
  return copied;
}

/**
 * Move the database out of the way and drop any side files left behind: a
 * stale WAL replayed into the fresh database would corrupt it straight away.
 */
function moveAside(file: string, deps: OpenAgentDbDeps): string[] {
  const moved: string[] = [];
  if (deps.fs.existsSync(file)) {
    const to = asideName(file, deps, '');
    deps.fs.renameSync(file, to);
    moved.push(to);
  }
  for (const suffix of ['-wal', '-shm']) deps.fs.rmSync(`${file}${suffix}`, { force: true });
  return moved;
}

export function openAgentDbAt(file: string, deps: OpenAgentDbDeps): Database.Database {
  deps.fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: Database.Database | null = null;
  try {
    db = deps.open(file);
    configure(db);
    check(db, deps);
    return db;
  } catch (err) {
    const corrupt = isCorruption(err);
    const copied = corrupt ? copySideFilesAside(file, deps) : [];
    try {
      db?.close();
    } catch {
      // Already unusable.
    }
    if (!corrupt) throw err;
    const moved = [...moveAside(file, deps), ...copied];
    deps.log.error('agent db was corrupt; moved it aside and started a fresh one', {
      err: String(err),
      moved,
    });
    const fresh = deps.open(file);
    configure(fresh);
    try {
      deps.notifyReset();
    } catch {
      // The log line above is the record; a notification is a courtesy.
    }
    return fresh;
  }
}

let shared: Database.Database | null = null;

/** The process's one connection to `userData/agent.db`, opened (and checked) on first use. */
export function openAgentDb(): Database.Database {
  if (shared) return shared;
  shared = openAgentDbAt(path.join(app.getPath('userData'), 'agent.db'), {
    open: (file) => new Database(file),
    fs,
    now: () => Date.now(),
    log,
    notifyReset: () => {
      showNotification({
        title: 'Timo repaired its local data',
        body: 'Timo’s local database was damaged, so it started a new one. Time already synced is safe.',
      });
    },
  });
  log.info('agent db opened', { file: shared.name });
  return shared;
}

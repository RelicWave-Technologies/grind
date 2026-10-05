import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/** App-dir names used by prior builds, as siblings of the current userData dir. */
const LEGACY_APP_DIRS = ['Grind', path.join('@grind', 'agent')];
// The WAL and shared-memory files travel with the database: rows committed
// to the WAL but not yet checkpointed exist nowhere else.
const MIGRATE_ENTRIES = [
  'tokens.bin',
  'pending-lark-login.bin',
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
  'preferences.json',
  'screenshots',
];
const MIGRATED_SUFFIX = '.migrated-to-timo';

/**
 * Recover local state stranded by app identity changes. Windows userData is
 * derived from Electron's runtime app name, so both the Grind->Timo rebrand and
 * the scoped package fallback (@grind/agent) can leave tokens/local DB behind
 * while the fixed build reads %APPDATA%\Timo. safeStorage keys are user-scoped
 * (DPAPI on Windows), so the current build can still decrypt copied tokens.
 *
 * Only acts when the current dir has NO session, so it never clobbers a live
 * login, and is fully best-effort — a failure here must never block boot.
 */
export function migrateLegacyUserData(): void {
  try {
    const currentDir = app.getPath('userData');
    if (fs.existsSync(path.join(currentDir, 'tokens.bin'))) return; // already signed in here
    const parent = path.dirname(currentDir);
    for (const name of LEGACY_APP_DIRS) {
      const legacyDir = path.join(parent, name);
      if (legacyDir === currentDir || !fs.existsSync(path.join(legacyDir, 'tokens.bin'))) continue;
      fs.mkdirSync(currentDir, { recursive: true });
      const copied = new Set<string>();
      for (const entry of MIGRATE_ENTRIES) {
        const from = path.join(legacyDir, entry);
        const to = path.join(currentDir, entry);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.cpSync(from, to, { recursive: true });
          quarantineLegacyEntry(from);
          copied.add(entry);
        }
      }
      const repointed = copied.has('agent.db')
        ? repointScreenshotPaths(path.join(currentDir, 'agent.db'), legacyDir, currentDir)
        : 0;
      log.info('migrated legacy session from prior app identity', { from: legacyDir, to: currentDir, repointed });
      return;
    }
  } catch (err) {
    log.warn('legacy userData migration failed', { err: String(err) });
  }
}

function quarantineLegacyEntry(file: string): void {
  try {
    const backup = `${file}${MIGRATED_SUFFIX}`;
    if (fs.existsSync(backup)) fs.rmSync(file, { force: true });
    else fs.renameSync(file, backup);
  } catch (err) {
    log.warn('legacy userData quarantine failed', { file, err: String(err) });
  }
}

function hasPathPrefix(value: string, prefix: string): boolean {
  if (process.platform !== 'win32') return value.startsWith(prefix);
  // Windows paths are case-insensitive and may mix separators.
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return norm(value).startsWith(norm(prefix));
}

/**
 * The copied database still names every queued screenshot by its absolute
 * path under the OLD app directory, which was just renamed to
 * `screenshots.migrated-to-timo`. To the retention janitor those rows point at
 * missing files, so it deleted the whole unuploaded queue. Rewrite them to
 * the new location. Paths already stored relative to userData are left alone.
 *
 * Best-effort like the rest of the migration: a database that cannot be opened
 * is reported and left exactly as copied.
 *
 * @returns how many rows were repointed.
 */
export function repointScreenshotPaths(dbPath: string, fromDir: string, toDir: string): number {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screenshots'`).get();
    if (!table) return 0;
    const fromPrefix = `${fromDir}${path.sep}`;
    const toPrefix = `${toDir}${path.sep}`;
    const rows = db.prepare(`SELECT id, file_path FROM screenshots`).all() as Array<{ id: string; file_path: string }>;
    const update = db.prepare(`UPDATE screenshots SET file_path = ? WHERE id = ?`);
    let repointed = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (typeof row.file_path !== 'string' || !hasPathPrefix(row.file_path, fromPrefix)) continue;
        update.run(toPrefix + row.file_path.slice(fromPrefix.length), row.id);
        repointed += 1;
      }
    })();
    return repointed;
  } catch (err) {
    log.warn('legacy screenshot paths could not be repointed', { err: String(err) });
    return 0;
  } finally {
    db?.close();
  }
}

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/** App-dir names used by prior builds, as siblings of the current userData dir. */
const LEGACY_APP_DIRS = ['Grind', path.join('@grind', 'agent')];
const MIGRATE_ENTRIES = ['tokens.bin', 'pending-lark-login.bin', 'agent.db', 'preferences.json', 'screenshots'];
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
      for (const entry of MIGRATE_ENTRIES) {
        const from = path.join(legacyDir, entry);
        const to = path.join(currentDir, entry);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.cpSync(from, to, { recursive: true });
          quarantineLegacyEntry(from);
        }
      }
      log.info('migrated legacy session from prior app identity', { from: legacyDir, to: currentDir });
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

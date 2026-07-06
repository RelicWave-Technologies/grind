import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/** App-dir names used by prior builds, as siblings of the current userData dir. */
const LEGACY_APP_DIRS = ['Grind'];
const MIGRATE_FILES = ['tokens.bin', 'pending-lark-login.bin'];

/**
 * Recover a session stranded by the Grind->Timo rebrand. On Windows the
 * userData dir is named after productName, so the rename left the old encrypted
 * token file behind in %APPDATA%\Grind while the new build reads %APPDATA%\Timo
 * and finds nothing -> logged out. safeStorage keys are user-scoped (DPAPI on
 * Windows) so the current build can still decrypt the copied file.
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
      for (const file of MIGRATE_FILES) {
        const from = path.join(legacyDir, file);
        const to = path.join(currentDir, file);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
      }
      log.info('migrated legacy session from prior app identity', { from: legacyDir, to: currentDir });
      return;
    }
  } catch (err) {
    log.warn('legacy userData migration failed', { err: String(err) });
  }
}

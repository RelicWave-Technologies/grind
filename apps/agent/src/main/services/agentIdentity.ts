import { app } from 'electron';
import type { Platform } from '@grind/types';

/**
 * Who this agent is, as stamped on everything it sends the server.
 *
 * The version comes from Electron, never from `npm_package_version`: that
 * variable only exists when the process was launched by pnpm/npm, so every
 * packaged build used to report "0.0.1" on its time entries.
 */
const UNKNOWN_VERSION = '0.0.0-unknown';

export function agentVersion(): string {
  try {
    return app.getVersion() || UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function currentPlatform(nodePlatform: NodeJS.Platform = process.platform): Platform {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'win32') return 'win32';
  return 'linux';
}

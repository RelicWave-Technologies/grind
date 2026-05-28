import { systemPreferences } from 'electron';

export type ScreenStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/**
 * Screen Recording permission status (macOS). On other platforms screen capture
 * needs no permission, so we report 'granted'. Uses Electron's built-in
 * systemPreferences (no native module / Linux build issues).
 */
export function screenStatus(): ScreenStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') as ScreenStatus;
  } catch {
    return 'unknown';
  }
}

export function hasScreenAccess(): boolean {
  const s = screenStatus();
  return s === 'granted';
}

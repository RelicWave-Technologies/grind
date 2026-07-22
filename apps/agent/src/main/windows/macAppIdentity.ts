import { app } from 'electron';

/**
 * Keep Timo registered as one normal Dock and Cmd+Tab application. Overlay
 * windows must never change this process-wide identity.
 */
export function ensureRegularMacApplication(): void {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy('regular');
}

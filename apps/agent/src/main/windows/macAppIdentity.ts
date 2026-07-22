import { app } from 'electron';

/**
 * Timo is a normal desktop application, even while one of its overlays is
 * visible on every Space. Electron's macOS all-workspaces API temporarily
 * changes the process to UIElement so an overlay can join a fullscreen Space;
 * restoring this policy keeps the host visible in the Dock and Cmd+Tab.
 */
export function ensureRegularMacApplication(): void {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy('regular');
}

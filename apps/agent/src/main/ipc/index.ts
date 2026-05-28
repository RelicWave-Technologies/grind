import type { BrowserWindow } from 'electron';
import { registerAuthIpc } from './auth';
import { registerProjectsIpc } from './projects';
import { registerStatusIpc } from './status';

export function registerIpc(opts: { trayWindow: BrowserWindow }): void {
  registerAuthIpc(opts.trayWindow);
  registerProjectsIpc();
  registerStatusIpc();
}

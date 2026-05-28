import { ipcMain } from 'electron';
import { registerAuthIpc } from './auth';
import { registerProjectsIpc } from './projects';
import { registerStatusIpc } from './status';
import { registerTimerIpc } from './timer';

export function registerIpc(opts: { onOpenMainWindow: () => void }): void {
  registerAuthIpc();
  registerProjectsIpc();
  registerStatusIpc();
  registerTimerIpc();

  // Lets the floating bar / popover ask to bring up the main window.
  ipcMain.handle('window:openMain', () => opts.onOpenMainWindow());
}

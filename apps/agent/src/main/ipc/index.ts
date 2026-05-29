import { ipcMain } from 'electron';
import { registerAuthIpc } from './auth';
import { registerProjectsIpc } from './projects';
import { registerStatusIpc } from './status';
import { registerTimerIpc } from './timer';
import { registerCaptureIpc } from './capture';
import { registerSettingsIpc } from './settings';
import { registerLarkIpc } from './lark';
import { registerInsightsIpc } from './insights';

export function registerIpc(opts: { onOpenMainWindow: () => void }): void {
  registerAuthIpc();
  registerProjectsIpc();
  registerStatusIpc();
  registerTimerIpc();
  registerCaptureIpc();
  registerSettingsIpc();
  registerLarkIpc();
  registerInsightsIpc();

  // Lets the floating bar / popover ask to bring up the main window.
  ipcMain.handle('window:openMain', () => opts.onOpenMainWindow());
}

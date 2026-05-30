import { ipcMain } from 'electron';
import { registerAuthIpc } from './auth';
import { registerStatusIpc } from './status';
import { registerTimerIpc } from './timer';
import { registerCaptureIpc } from './capture';
import { registerSettingsIpc } from './settings';
import { registerLarkIpc } from './lark';
import { registerInsightsIpc } from './insights';
import { registerTimeRequestsIpc } from './timeRequests';

export function registerIpc(opts: { onOpenMainWindow: () => void }): void {
  registerAuthIpc();
  registerStatusIpc();
  registerTimerIpc();
  registerCaptureIpc();
  registerSettingsIpc();
  registerLarkIpc();
  registerInsightsIpc();
  registerTimeRequestsIpc();

  // Lets the floating bar / popover ask to bring up the main window.
  ipcMain.handle('window:openMain', () => opts.onOpenMainWindow());
}

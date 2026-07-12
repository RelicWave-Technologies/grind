import { ipcMain } from 'electron';
import { registerAuthIpc } from './auth';
import { registerStatusIpc } from './status';
import { registerTimerIpc } from './timer';
import { registerAwayIpc } from './away';
import { registerCaptureIpc } from './capture';
import { registerSettingsIpc } from './settings';
import { registerLarkIpc } from './lark';
import { registerInsightsIpc } from './insights';
import { registerAppIpc } from './app';
import { registerUpdatesIpc } from './updates';
import { registerPermissionsIpc } from './permissions';

export function registerIpc(opts: { onOpenMainWindow: () => void }): void {
  registerAuthIpc();
  registerStatusIpc();
  registerTimerIpc();
  registerAwayIpc();
  registerCaptureIpc();
  registerSettingsIpc();
  registerLarkIpc();
  registerInsightsIpc();
  registerAppIpc();
  registerUpdatesIpc();
  registerPermissionsIpc();

  // Lets the floating bar / popover ask to bring up the main window.
  ipcMain.handle('window:openMain', () => opts.onOpenMainWindow());
}

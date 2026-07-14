import { ipcMain } from 'electron';
import { registerAuthIpc } from './auth';
import { registerStatusIpc } from './status';
import { registerTimerIpc } from './timer';
import { registerCaptureIpc } from './capture';
import { registerSettingsIpc } from './settings';
import { registerLarkIpc } from './lark';
import { registerInsightsIpc } from './insights';
import { registerAppIpc } from './app';
import { registerUpdatesIpc } from './updates';
import { registerPermissionsIpc } from './permissions';
import { registerAttentionIpc } from './attention';
import { getWorkspaceTimeContext } from '../services/workspaceTime';

export function registerIpc(opts: {
  onOpenMainWindow: () => void;
  onDismissFloatingBar: () => void;
  onIdleResolved: () => void;
}): void {
  registerAuthIpc();
  registerStatusIpc();
  registerTimerIpc();
  registerCaptureIpc();
  registerSettingsIpc();
  registerLarkIpc();
  registerInsightsIpc();
  registerAppIpc();
  registerUpdatesIpc();
  registerPermissionsIpc();
  registerAttentionIpc({ onIdleResolved: opts.onIdleResolved });
  ipcMain.handle('workspaceTime:get', () => getWorkspaceTimeContext());

  // Lets the floating bar / popover ask to bring up the main window.
  ipcMain.handle('window:openMain', () => opts.onOpenMainWindow());
  ipcMain.handle('window:dismissFloatingBar', () => opts.onDismissFloatingBar());
}

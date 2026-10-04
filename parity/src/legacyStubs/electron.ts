import { world } from './state';

export const powerMonitor = { getSystemIdleTime: (): number => world.idleSeconds };
export const app = {};
export const systemPreferences = {};
export const desktopCapturer = {};
export const screen = {};
export class BrowserWindow {}
// `shell.openExternal` for auth.ts (timo-sync parity): records the URL, or fails when scripted.
import { sync } from './syncState';
export const shell = {
  openExternal: async (url: string): Promise<void> => {
    sync.opened.push(url);
    if (sync.openFails) throw new Error('boom');
  },
};

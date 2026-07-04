import { app } from 'electron';
import type { App, LoginItemSettings, LoginItemSettingsOptions, Settings } from 'electron';

const HIDDEN_ARG = '--hidden';

export type LaunchAtLoginStatus =
  | 'enabled'
  | 'not-registered'
  | 'requires-approval'
  | 'not-found'
  | 'blocked-dmg'
  | 'unavailable-dev';

export type LaunchAtLoginReason = 'running-from-dmg' | null;

export interface LaunchAtLoginInfo {
  enabled: boolean;
  status: LaunchAtLoginStatus;
  canRegister: boolean;
  reason: LaunchAtLoginReason;
}

interface LaunchAtLoginDeps {
  app: Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>;
  platform: NodeJS.Platform;
  execPath: string;
}

const SUPPORTED_MAC_STATUSES = new Set<LaunchAtLoginStatus>([
  'enabled',
  'not-registered',
  'requires-approval',
  'not-found',
]);

function defaultDeps(): LaunchAtLoginDeps {
  return { app, platform: process.platform, execPath: process.execPath };
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function isMacDmgPath(platform: NodeJS.Platform, execPath: string): boolean {
  return platform === 'darwin' && /^\/Volumes\/.*\.app\/Contents\/MacOS\//.test(execPath);
}

function queryOptions(deps: LaunchAtLoginDeps): LoginItemSettingsOptions | undefined {
  if (deps.platform !== 'win32') return undefined;
  return { path: deps.execPath, args: [HIDDEN_ARG] };
}

function registrationSettings(deps: LaunchAtLoginDeps): Settings {
  if (deps.platform === 'win32') {
    return { openAtLogin: true, path: deps.execPath, args: [HIDDEN_ARG] };
  }
  return { openAtLogin: true };
}

function macStatus(settings: LoginItemSettings): LaunchAtLoginStatus {
  if (SUPPORTED_MAC_STATUSES.has(settings.status as LaunchAtLoginStatus)) {
    return settings.status as LaunchAtLoginStatus;
  }
  return settings.openAtLogin ? 'enabled' : 'not-registered';
}

function fromSettings(deps: LaunchAtLoginDeps, settings: LoginItemSettings): LaunchAtLoginInfo {
  const status = deps.platform === 'darwin'
    ? macStatus(settings)
    : settings.openAtLogin
      ? 'enabled'
      : 'not-registered';
  const enabled = status === 'enabled' && settings.openAtLogin;
  return {
    enabled,
    status,
    canRegister: !enabled && status !== 'requires-approval',
    reason: null,
  };
}

function blocked(status: LaunchAtLoginStatus, reason: LaunchAtLoginReason = null): LaunchAtLoginInfo {
  return { enabled: false, status, canRegister: false, reason };
}

export function createLaunchAtLoginService(deps: LaunchAtLoginDeps) {
  function getInfo(): LaunchAtLoginInfo {
    if (!deps.app.isPackaged || !isSupportedPlatform(deps.platform)) {
      return blocked('unavailable-dev');
    }
    if (isMacDmgPath(deps.platform, deps.execPath)) {
      return blocked('blocked-dmg', 'running-from-dmg');
    }
    return fromSettings(deps, deps.app.getLoginItemSettings(queryOptions(deps)));
  }

  function enable(): LaunchAtLoginInfo {
    const current = getInfo();
    if (!current.canRegister) return current;
    deps.app.setLoginItemSettings(registrationSettings(deps));
    return getInfo();
  }

  function shouldStartHidden(argv: string[]): boolean {
    if (argv.includes(HIDDEN_ARG)) return true;
    if (!deps.app.isPackaged || deps.platform !== 'darwin') return false;
    if (isMacDmgPath(deps.platform, deps.execPath)) return false;
    return deps.app.getLoginItemSettings(queryOptions(deps)).wasOpenedAtLogin;
  }

  return { getInfo, enable, shouldStartHidden };
}

export function getLaunchAtLoginInfo(): LaunchAtLoginInfo {
  return createLaunchAtLoginService(defaultDeps()).getInfo();
}

export function enableLaunchAtLogin(): LaunchAtLoginInfo {
  return createLaunchAtLoginService(defaultDeps()).enable();
}

export function ensureLaunchAtLogin(): LaunchAtLoginInfo {
  return enableLaunchAtLogin();
}

export function shouldStartHidden(argv: string[] = process.argv): boolean {
  return createLaunchAtLoginService(defaultDeps()).shouldStartHidden(argv);
}

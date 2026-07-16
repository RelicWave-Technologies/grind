import { app } from 'electron';
import type { App, LoginItemSettings, LoginItemSettingsOptions, Settings } from 'electron';
import path from 'node:path';
import type {
  LaunchAtLoginHealth,
  LaunchAtLoginRemediation,
  LaunchAtLoginState,
  LaunchOrigin,
} from '../../shared/launchAtLogin';

const HIDDEN_ARG = '--hidden';
const WINDOWS_ITEM_NAME = 'Timo';
const WINDOWS_DESCRIPTION_NAME = 'Timo time tracker desktop agent';
const LEGACY_WINDOWS_ITEMS = [
  { name: 'Grind', appDir: 'Grind', executable: 'Grind.exe' },
  { name: '@grind/agent', appDir: '@grind', executable: 'agent.exe' },
] as const;
const WINDOWS_OWNED_NAMES = new Set([
  WINDOWS_ITEM_NAME.toLowerCase(),
  WINDOWS_DESCRIPTION_NAME.toLowerCase(),
  ...LEGACY_WINDOWS_ITEMS.map((item) => item.name.toLowerCase()),
]);

interface LaunchAtLoginApp {
  isPackaged: boolean;
  getLoginItemSettings(options?: LoginItemSettingsOptions): LoginItemSettings;
  setLoginItemSettings(settings: Settings): void;
  isInApplicationsFolder(): boolean;
  moveToApplicationsFolder(options?: Parameters<App['moveToApplicationsFolder']>[0]): boolean;
}

interface LaunchAtLoginDeps {
  app: LaunchAtLoginApp;
  platform: NodeJS.Platform;
  execPath: string;
  argv: string[];
  now: () => number;
}

type WindowsLaunchItem = LoginItemSettings['launchItems'][number];

function defaultDeps(): LaunchAtLoginDeps {
  return {
    app,
    platform: process.platform,
    execPath: process.execPath,
    argv: process.argv,
    now: () => Date.now(),
  };
}

function supported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function canonicalQuery(deps: LaunchAtLoginDeps): LoginItemSettingsOptions | undefined {
  if (deps.platform === 'darwin') return { type: 'mainAppService' };
  if (deps.platform === 'win32') return { path: deps.execPath, args: [HIDDEN_ARG] };
  return undefined;
}

function canonicalRegistration(deps: LaunchAtLoginDeps, openAtLogin = true): Settings {
  if (deps.platform === 'darwin') {
    return { openAtLogin, type: 'mainAppService' };
  }
  return {
    openAtLogin,
    enabled: openAtLogin,
    name: WINDOWS_ITEM_NAME,
    path: deps.execPath,
    args: [HIDDEN_ARG],
  };
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value.replace(/^"|"$/gu, '')).toLowerCase();
}

function normalizeWindowsName(value: string): string {
  return value.trim().toLowerCase();
}

function sameArgs(args: string[]): boolean {
  return args.length === 1 && args[0] === HIDDEN_ARG;
}

function sameWindowsPath(left: string, right: string): boolean {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function isCurrentWindowsItem(item: WindowsLaunchItem, execPath: string): boolean {
  return sameWindowsPath(item.path, execPath);
}

function isCanonicalWindowsItem(item: WindowsLaunchItem, execPath: string): boolean {
  return (item.name === WINDOWS_ITEM_NAME || item.name === WINDOWS_DESCRIPTION_NAME)
    && isCurrentWindowsItem(item, execPath)
    && sameArgs(item.args);
}

function isOwnedWindowsStartupItem(item: WindowsLaunchItem, execPath: string): boolean {
  const name = normalizeWindowsName(item.name);
  if (WINDOWS_OWNED_NAMES.has(name)) return true;

  if (sameWindowsPath(item.path, execPath)) return true;

  const normalizedPath = normalizeWindowsPath(item.path);
  const executable = path.win32.basename(normalizedPath);
  if (executable === 'timo.exe' && normalizedPath.includes('\\timo\\')) return true;
  if (executable === 'grind.exe' && normalizedPath.includes('\\grind\\')) return true;
  if (executable === 'agent.exe' && normalizedPath.includes('\\@grind\\')) return true;

  return false;
}

function result(
  deps: LaunchAtLoginDeps,
  openedAtLogin: boolean,
  state: LaunchAtLoginState,
  remediation: LaunchAtLoginRemediation,
  canRepair: boolean,
): LaunchAtLoginHealth {
  return {
    required: state !== 'UNAVAILABLE',
    ready: state === 'READY',
    state,
    canRepair,
    remediation,
    openedAtLogin,
    checkedAt: new Date(deps.now()).toISOString(),
  };
}

function detectOpenedAtLogin(deps: LaunchAtLoginDeps): boolean {
  if (!deps.app.isPackaged || !supported(deps.platform)) return false;
  if (deps.platform === 'win32') return isHiddenLaunch(deps.argv);
  try {
    return deps.app.getLoginItemSettings(canonicalQuery(deps)).wasOpenedAtLogin;
  } catch {
    return false;
  }
}

export function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes(HIDDEN_ARG);
}

function inspectMac(deps: LaunchAtLoginDeps, openedAtLogin: boolean): LaunchAtLoginHealth {
  if (!deps.app.isInApplicationsFolder()) {
    return result(deps, openedAtLogin, 'NEEDS_INSTALL', 'MOVE_TO_APPLICATIONS', false);
  }
  try {
    const settings = deps.app.getLoginItemSettings(canonicalQuery(deps));
    if (settings.status === 'enabled' && settings.openAtLogin) {
      return result(deps, openedAtLogin, 'READY', 'NONE', false);
    }
    if (settings.status === 'requires-approval') {
      return result(deps, openedAtLogin, 'NEEDS_APPROVAL', 'OPEN_LOGIN_ITEMS', false);
    }
    if (settings.status === 'not-registered' || settings.status === 'not-found') {
      return result(deps, openedAtLogin, 'NEEDS_REGISTRATION', 'REGISTER', true);
    }
    return result(deps, openedAtLogin, 'BLOCKED', 'OPEN_LOGIN_ITEMS', false);
  } catch {
    return result(deps, openedAtLogin, 'BLOCKED', 'OPEN_LOGIN_ITEMS', false);
  }
}

function inspectWindows(deps: LaunchAtLoginDeps, openedAtLogin: boolean): LaunchAtLoginHealth {
  try {
    const settings = deps.app.getLoginItemSettings(canonicalQuery(deps));
    const canonicalItem = settings.launchItems.find((item) => isCanonicalWindowsItem(item, deps.execPath));
    const enabledCurrentItem = settings.launchItems.find((item) =>
      isCurrentWindowsItem(item, deps.execPath) && item.enabled === true,
    );
    const executableReady = settings.executableWillLaunchAtLogin === true;
    if (enabledCurrentItem || (settings.openAtLogin && executableReady && canonicalItem?.enabled === true)) {
      return result(deps, openedAtLogin, 'READY', 'NONE', false);
    }
    const relatedItem = settings.launchItems.some((item) => isOwnedWindowsStartupItem(item, deps.execPath));
    if (settings.openAtLogin || relatedItem) {
      return result(deps, openedAtLogin, 'NEEDS_REPAIR', 'ENABLE_STARTUP', true);
    }
    return result(deps, openedAtLogin, 'NEEDS_REGISTRATION', 'REGISTER', true);
  } catch {
    return result(deps, openedAtLogin, 'BLOCKED', 'OPEN_STARTUP_APPS', false);
  }
}

export function createLaunchAtLoginService(deps: LaunchAtLoginDeps) {
  const openedAtLogin = detectOpenedAtLogin(deps);

  function inspect(): LaunchAtLoginHealth {
    if (!deps.app.isPackaged || !supported(deps.platform)) {
      return result(deps, openedAtLogin, 'UNAVAILABLE', 'NONE', false);
    }
    return deps.platform === 'darwin'
      ? inspectMac(deps, openedAtLogin)
      : inspectWindows(deps, openedAtLogin);
  }

  function removeWindowsItem(item: WindowsLaunchItem): void {
    deps.app.setLoginItemSettings({
      openAtLogin: false,
      enabled: false,
      name: item.name,
      path: item.path,
      args: item.args,
    });
  }

  function cleanupWindowsItems(): void {
    if (!deps.app.isPackaged || deps.platform !== 'win32') return;
    try {
      const settings = deps.app.getLoginItemSettings();
      for (const item of settings.launchItems) {
        const canonical = isCanonicalWindowsItem(item, deps.execPath);
        const current = isCurrentWindowsItem(item, deps.execPath);
        if (!canonical && !current && isOwnedWindowsStartupItem(item, deps.execPath)) removeWindowsItem(item);
      }
    } catch {
      // Keep startup non-fatal; repair() will surface a blocked state.
    }

    const programsDir = path.win32.dirname(path.win32.dirname(deps.execPath));
    for (const legacy of LEGACY_WINDOWS_ITEMS) {
      const legacyPath = path.win32.join(programsDir, legacy.appDir, legacy.executable);
      deps.app.setLoginItemSettings({
        openAtLogin: false,
        enabled: false,
        name: legacy.name,
        path: legacyPath,
        args: [HIDDEN_ARG],
      });
      deps.app.setLoginItemSettings({
        openAtLogin: false,
        enabled: false,
        name: legacy.name,
        path: legacyPath,
      });
    }
  }

  function blockedAfterAttempt(next: LaunchAtLoginHealth): LaunchAtLoginHealth {
    if (next.ready || next.state === 'NEEDS_APPROVAL' || next.state === 'NEEDS_INSTALL') return next;
    return result(
      deps,
      openedAtLogin,
      'BLOCKED',
      deps.platform === 'darwin' ? 'OPEN_LOGIN_ITEMS' : 'OPEN_STARTUP_APPS',
      false,
    );
  }

  function registerAndVerify(): LaunchAtLoginHealth {
    try {
      deps.app.setLoginItemSettings(canonicalRegistration(deps));
      return blockedAfterAttempt(inspect());
    } catch {
      return result(
        deps,
        openedAtLogin,
        'BLOCKED',
        deps.platform === 'darwin' ? 'OPEN_LOGIN_ITEMS' : 'OPEN_STARTUP_APPS',
        false,
      );
    }
  }

  function reconcileOnBoot(): LaunchAtLoginHealth {
    cleanupWindowsItems();
    const health = inspect();
    return health.state === 'NEEDS_REGISTRATION' ? registerAndVerify() : health;
  }

  function repair(): LaunchAtLoginHealth {
    cleanupWindowsItems();
    const health = inspect();
    if (health.state !== 'NEEDS_REGISTRATION' && health.state !== 'NEEDS_REPAIR') return health;
    return registerAndVerify();
  }

  function moveToApplicationsFolder(options?: Parameters<App['moveToApplicationsFolder']>[0]): boolean {
    if (!deps.app.isPackaged || deps.platform !== 'darwin' || deps.app.isInApplicationsFolder()) return false;
    return deps.app.moveToApplicationsFolder(options);
  }

  function launchOrigin(): LaunchOrigin {
    if (!deps.app.isPackaged || !supported(deps.platform)) return 'UNKNOWN';
    return openedAtLogin ? 'LOGIN_ITEM' : 'USER';
  }

  return {
    inspect,
    reconcileOnBoot,
    repair,
    moveToApplicationsFolder,
    launchOrigin,
    shouldStartHidden: () => openedAtLogin,
  };
}

let singleton: ReturnType<typeof createLaunchAtLoginService> | null = null;

export function getLaunchAtLoginService() {
  if (!singleton) singleton = createLaunchAtLoginService(defaultDeps());
  return singleton;
}

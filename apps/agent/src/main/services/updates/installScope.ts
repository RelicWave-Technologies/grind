/**
 * Where this Windows install lives, and so whether it can update itself.
 *
 * electron-updater runs the downloaded NSIS installer with the agent's own
 * (unelevated) token: our feed never says `isAdminRightsRequired` because the
 * build is per-user (electron-builder only writes it for perMachine builds).
 * An install that landed under Program Files — someone picked "Anyone who uses
 * this computer", possibly during an earlier update's installer wizard — can
 * therefore never update quietly: the NSIS installer elevates itself with a
 * UAC prompt on every update (installer.nsi, "silent upgrade of a per-machine
 * installation"), which a standard user cannot answer. An update that does
 * not run to completion there leaves a broken app — the likely story behind
 * `Cannot find module ...\Program Files\Grind\Timo\resources\app\out\main\index.cjs`.
 *
 * Per-user installs live under %LOCALAPPDATA%\Programs\<name> and update
 * without elevation. Anything else (a hand-picked directory) is "unknown":
 * the path alone cannot say who owns it, so it is left to update as before.
 */
export type InstallScope = 'user' | 'machine' | 'unknown';

type Env = Record<string, string | undefined>;

/** Lower-case, backslash-separated, no long-path prefix, no trailing slash. */
function normalizeWindowsPath(value: string): string {
  let p = value.trim().replace(/\//g, '\\').toLowerCase();
  if (p.startsWith('\\\\?\\')) p = p.slice(4);
  while (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
  return p;
}

function isUnder(file: string, root: string | undefined): boolean {
  if (!root || !root.trim()) return false;
  const dir = normalizeWindowsPath(root);
  return file.startsWith(`${dir}\\`);
}

/**
 * Program Files roots. The env names cover x64 (ProgramFiles), the 32-bit view
 * (ProgramFiles(x86)) and the native one a 32-bit process sees (ProgramW6432).
 * The literal fallbacks catch a process started with a stripped environment,
 * and the 8.3 forms a shortcut can resolve to.
 */
function programFilesRoots(env: Env): string[] {
  const drive = (env.SystemDrive || 'C:').replace(/\\$/, '');
  return [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    `${drive}\\Program Files`,
    `${drive}\\Program Files (x86)`,
    `${drive}\\PROGRA~1`,
    `${drive}\\PROGRA~2`,
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);
}

/**
 * Classify the running executable. Windows only; every other platform is
 * "unknown" (macOS updates through Squirrel and has no per-machine split).
 */
export function detectInstallScope(
  execPath: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): InstallScope {
  if (platform !== 'win32' || !execPath) return 'unknown';
  const exe = normalizeWindowsPath(execPath);
  if (programFilesRoots(env).some((root) => isUnder(exe, root))) return 'machine';
  if (isUnder(exe, env.LOCALAPPDATA)) return 'user';
  // %LOCALAPPDATA% is normally <profile>\AppData\Local; trust the profile path
  // when the variable itself is missing.
  if (isUnder(exe, env.USERPROFILE ? `${env.USERPROFILE}\\AppData\\Local` : undefined)) return 'user';
  return 'unknown';
}

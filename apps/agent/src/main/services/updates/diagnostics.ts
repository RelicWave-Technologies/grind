import { detectInstallScope, type InstallScope } from './installScope';

/**
 * Update health the heartbeat reports, kept apart from the updater itself so
 * the heartbeat does not have to load electron-updater to read two values.
 */
let installScope: InstallScope | null = null;
let lastUpdateError: string | null = null;

export function noteInstallScope(scope: InstallScope): void {
  installScope = scope;
}

export function currentInstallScope(): InstallScope {
  installScope ??= detectInstallScope(process.execPath, process.env);
  return installScope;
}

/** Last check/download/install failure; null once an update check succeeds. */
export function noteUpdateError(message: string | null): void {
  lastUpdateError = message;
}

export function getUpdateDiagnostics(): { installScope: InstallScope; updateError: string | null } {
  return { installScope: currentInstallScope(), updateError: lastUpdateError };
}

export function resetUpdateDiagnosticsForTests(): void {
  installScope = null;
  lastUpdateError = null;
}

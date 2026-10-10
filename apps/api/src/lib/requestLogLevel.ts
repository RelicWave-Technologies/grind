import type { LevelWithSilent } from 'pino';

/**
 * Agent traffic that succeeds is not news. Every installed agent heartbeats each
 * minute, syncs its timer, and uploads activity and screenshots, so logging each
 * of those at info was ~13M lines a day and most of a nearly full disk. They
 * log at debug (off in production); the same routes failing still log.
 */
const QUIET_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/v1\/agent\/heartbeat$/u },
  { method: 'PUT', path: /^\/v1\/time-entries\/[^/]+\/sync$/u },
  { method: 'POST', path: /^\/v1\/activity-samples$/u },
  { method: 'POST', path: /^\/v1\/screenshots\/(sign|direct-upload|complete)$/u },
  { method: 'GET', path: /^\/healthz?$/u },
];

/** The level pino-http logs a finished request at. */
export function requestLogLevel(method: string | undefined, url: string | undefined, status: number, err?: unknown): LevelWithSilent {
  if (err || status >= 500) return 'error';
  if (status >= 400) return 'warn';
  const path = (url ?? '').split('?')[0]!;
  return QUIET_ROUTES.some((route) => route.method === method && route.path.test(path)) ? 'debug' : 'info';
}

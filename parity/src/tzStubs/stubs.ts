/**
 * Stand-ins for the Electron-bound neighbours of `workspaceTime.ts` and
 * `agentConfig.ts` (see hooks.mjs). One module serves every redirected
 * specifier, so it exports the union of the names they import. The mutable
 * `world` is what a parity driver sets before it pokes the real service.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  workspaceId: string;
}

export const world = {
  session: null as Session | null,
  /** What `api('/v1/agent/config')` resolves to, or the error it rejects with. */
  response: undefined as unknown,
  responseError: null as Error | null,
  /** `applyServerWorkspaceTimeZone(value, workspaceId)` calls the real agentConfig made. */
  timeZoneCalls: [] as Array<[string, string]>,
  /** The clock `serverAlignedNow()` reads. */
  now: 0,
  logs: [] as Array<{ level: string; message: string }>,
};

export async function loadTokens(): Promise<Session | null> {
  return world.session;
}

export function serverAlignedNow(): number {
  return world.now;
}

const write = (level: string) => (message: string): void => {
  world.logs.push({ level, message });
};
export const log = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };

export async function api<T>(_path: string): Promise<T> {
  if (world.responseError) throw world.responseError;
  return world.response as T;
}

/** `../env`: live bindings, set per scenario before the module is imported. */
export let SCREENSHOT_INTERVAL_SEC = 180;
export let IDLE_THRESHOLD_SEC = 300;
export let SHOT_SEC_LOCKED = false;
export let IDLE_SEC_LOCKED = false;
export function setEnv(env: { screenshotIntervalSec: number; idleThresholdSec: number; shotLocked: boolean; idleLocked: boolean }): void {
  SCREENSHOT_INTERVAL_SEC = env.screenshotIntervalSec;
  IDLE_THRESHOLD_SEC = env.idleThresholdSec;
  SHOT_SEC_LOCKED = env.shotLocked;
  IDLE_SEC_LOCKED = env.idleLocked;
}

/** `./workspaceTime` as agentConfig sees it: record the call instead of touching disk. */
export async function applyServerWorkspaceTimeZone(value: string, workspaceId: string): Promise<void> {
  world.timeZoneCalls.push([value, workspaceId]);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs scenarios one at a time. Generator modules that await at the top level
 * are evaluated concurrently, and every scenario drives the one shared `world`
 * (and the one `setEnv` state), so two of them interleaving would corrupt each other.
 */
export function exclusive<T>(scenario: () => Promise<T>): Promise<T> {
  const result = queue.then(scenario, scenario);
  queue = result.catch(() => undefined);
  return result;
}

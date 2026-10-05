/**
 * Boot, in two phases.
 *
 * The old boot awaited the network before the app could do anything: the agent
 * config, three `/auth/me` round-trips and the shift fetch all ran before the
 * timer was bound to its owner and before the 1 Hz tick started. With no
 * request timeout, one stalled connection at login meant no tray time, no
 * floating bar, and a timer that could not be started — sometimes for good.
 *
 * LOCAL phase — disk only, so it finishes in milliseconds on any network:
 *   restore the cached workspace clock, bind the stored owner and close any
 *   dangling entry at its last proof of life, then start the tick and the
 *   local capture services, and only then accept deep links.
 *   The workspace clock comes first because timer recovery and the renderer's
 *   day totals read it; the timer is bound before the tick, the capture loop or
 *   a sign-in callback can touch it.
 *
 * ONLINE phase — in the background, after the local phase:
 *   refresh the agent config, kick the backlogs, start the heartbeat if a
 *   session is stored (the heartbeat validates it; a dead one signs out through
 *   the auth listener), offer permission setup, start the shift monitor.
 *   Config is refreshed before the drains so they run under current policy.
 *
 * Every step is isolated: one failing never skips the ones after it, except
 * that the timer sync drain only starts once the timer has booted.
 */
export interface BootSteps {
  initializeWorkspaceTime(): Promise<void>;
  initTimerOnBoot(): Promise<void>;
  startTimerSyncDrain(): void;
  startTick(): void;
  startLocalServices(): void;
  /** Local phase done: flush queued deep links, log ready. */
  onLocalReady(): void;

  refreshAgentConfig(): Promise<void>;
  drainBacklogs(): void;
  hasStoredSession(): Promise<boolean>;
  startHeartbeat(): void;
  offerPermissionSetup(): void;
  startShiftMonitor(): Promise<void>;

  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

async function step(steps: BootSteps, name: string, run: () => unknown): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    steps.log.warn(`boot: ${name} failed`, { err: String(err) });
    return false;
  }
}

export async function runLocalBootPhase(steps: BootSteps): Promise<void> {
  await step(steps, 'workspace time', () => steps.initializeWorkspaceTime());
  if (await step(steps, 'timer recovery', () => steps.initTimerOnBoot())) {
    await step(steps, 'timer sync drain', () => steps.startTimerSyncDrain());
  }
  await step(steps, 'tick', () => steps.startTick());
  await step(steps, 'local services', () => steps.startLocalServices());
  await step(steps, 'local ready', () => steps.onLocalReady());
}

export async function runOnlineBootPhase(steps: BootSteps): Promise<void> {
  await step(steps, 'agent config', () => steps.refreshAgentConfig());
  await step(steps, 'backlog drains', () => steps.drainBacklogs());
  let signedIn = false;
  await step(steps, 'session check', async () => {
    signedIn = await steps.hasStoredSession();
  });
  if (signedIn) {
    await step(steps, 'heartbeat', () => steps.startHeartbeat());
    await step(steps, 'permission setup offer', () => steps.offerPermissionSetup());
  }
  await step(steps, 'shift monitor', () => steps.startShiftMonitor());
}

/**
 * Run the local phase to completion, then start the online phase without
 * waiting for it. Resolves once the app is usable; `online` settles when the
 * background work has.
 */
export async function runBoot(steps: BootSteps): Promise<{ online: Promise<void> }> {
  await runLocalBootPhase(steps);
  const online = runOnlineBootPhase(steps).catch((err) => {
    steps.log.warn('boot: online phase failed', { err: String(err) });
  });
  return { online };
}

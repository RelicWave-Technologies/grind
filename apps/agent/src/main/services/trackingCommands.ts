import type { TimerStatus, TrackingCommandResult } from '../../shared/tracking';
import { broadcast } from '../broadcast';
import { sendHeartbeatNow } from './heartbeat';
import { rememberLastLarkTask } from './preferences';
import { getTimerService } from './timer';
import { getTrackingAttentionCoordinator } from './trackingAttention';
import { isTrackingBlockedError } from './trackingReadiness';
import { getTrackingReadinessService } from './trackingReadiness';

type PendingCommand =
  | { kind: 'START'; larkTaskGuid: string | null }
  | { kind: 'RESUME' };

// A login launch lands while the Mac is still busy bringing everything else up
// — the worst moment for a first screen probe, and for a window nobody asked
// for. The setup offer waits this long; Start/Resume still check at once.
const LOGIN_LAUNCH_SETUP_DELAY_MS = 30_000;
// A blank first probe reads as CHECKING while it is retried. Let it settle
// before deciding, rather than open a prompt that only says "Checking…".
const SETUP_SETTLE_RECHECKS = 3;
const SETUP_SETTLE_INTERVAL_MS = 5_000;

let pending: PendingCommand | null = null;
/**
 * Timer commands run one at a time, in the order they were given. The popover,
 * the main window, Ready-to-work and the welcome-back prompt can all fire at
 * once, and start/resume wait on a permission check before they act; two of
 * them interleaving across that wait raced a resume against a stop (resuming
 * an entry that no longer existed) and could leave two entries open.
 */
let commandChain: Promise<unknown> = Promise.resolve();

function serialized<T>(command: () => Promise<T>): Promise<T> {
  const run = commandChain.then(command, command);
  commandChain = run.catch(() => undefined);
  return run;
}
let startupPromptOffered = false;
// Bumped by a sign-out so a delayed offer from the old session stands down.
let setupOfferGeneration = 0;

/**
 * Every surface (main window, popover, floating bar, prompts) changes the timer
 * through here, so a successful command is the one place that can retire the
 * idle and welcome-back prompts it just answered. Left up, they invite a stale
 * click — "Take a break" on an idle prompt for a timer resumed elsewhere
 * stopped that running timer.
 */
function settled(status: TimerStatus): void {
  getTrackingAttentionCoordinator().clearTimerPrompts();
  broadcast('timer:status:push', status);
  sendHeartbeatNow();
}

async function execute(command: PendingCommand): Promise<TrackingCommandResult> {
  try {
    const timer = getTimerService();
    const status = command.kind === 'START'
      ? await timer.start({ larkTaskGuid: command.larkTaskGuid })
      : await timer.resume();
    // Persist the choice the moment tracking actually starts. Boot always closes
    // the open entry, so this file is the only thing that can carry "what was I
    // working on" across a restart.
    if (command.kind === 'START' && command.larkTaskGuid) {
      rememberLastLarkTask(command.larkTaskGuid);
    }
    pending = null;
    settled(status);
    return { ok: true, status };
  } catch (error) {
    if (!isTrackingBlockedError(error)) throw error;
    pending = command;
    const status = getTimerService().status();
    getTrackingAttentionCoordinator().requestPermission(command.kind === 'START' ? 'START_TASK' : 'RESUME_ENTRY');
    return {
      ok: false,
      reason: 'PERMISSIONS_REQUIRED',
      status,
      readiness: error.readiness,
    };
  }
}

export function startTracking(larkTaskGuid?: string | null): Promise<TrackingCommandResult> {
  return serialized(() => execute({ kind: 'START', larkTaskGuid: larkTaskGuid ?? null }));
}

export function resumeTracking(): Promise<TrackingCommandResult> {
  return serialized(() => execute({ kind: 'RESUME' }));
}

export function stopTracking(): Promise<TimerStatus> {
  pending = null;
  return serialized(async () => {
    const status = await getTimerService().stop();
    settled(status);
    return status;
  });
}

export function pauseTracking(): Promise<TimerStatus> {
  pending = null;
  return serialized(async () => {
    const status = await getTimerService().pause();
    settled(status);
    return status;
  });
}

export function retryPendingTrackingCommand(): Promise<TrackingCommandResult | null> {
  return serialized(() => (pending ? execute(pending) : Promise.resolve(null)));
}

export function offerPermissionResume(): void {
  pending = { kind: 'RESUME' };
  getTrackingAttentionCoordinator().requestPermission('RESUME_ENTRY');
}

export function offerPermissionStart(larkTaskGuid: string | null): void {
  pending = { kind: 'START', larkTaskGuid };
  getTrackingAttentionCoordinator().requestPermission('START_TASK');
}

export function clearPendingTrackingCommand(): void {
  pending = null;
}

export async function offerPermissionSetupOnStartup(opts: { openedAtLogin?: boolean } = {}): Promise<void> {
  if (startupPromptOffered) return;
  startupPromptOffered = true;
  const generation = setupOfferGeneration;
  const wait = async (ms: number): Promise<boolean> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return generation === setupOfferGeneration;
  };
  if (opts.openedAtLogin && !(await wait(LOGIN_LAUNCH_SETUP_DELAY_MS))) return;
  const readinessService = getTrackingReadinessService();
  let { readiness } = await readinessService.inspect({ verifyScreen: true });
  for (let recheck = 0; readiness.screenRecording === 'CHECKING' && recheck < SETUP_SETTLE_RECHECKS; recheck += 1) {
    if (!(await wait(SETUP_SETTLE_INTERVAL_MS))) return;
    ({ readiness } = await readinessService.recheck());
  }
  if (generation !== setupOfferGeneration) return;
  if (!readiness.ready) getTrackingAttentionCoordinator().requestPermission('SETUP');
}

export function resetPermissionSetupOffer(): void {
  startupPromptOffered = false;
  setupOfferGeneration += 1;
  pending = null;
  const coordinator = getTrackingAttentionCoordinator();
  if (coordinator.isPermissionActive()) coordinator.clear();
}

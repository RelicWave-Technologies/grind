import { powerMonitor } from 'electron';
import { broadcast } from '../broadcast';
import {
  onActivityCaptureStatusChange,
  setActivityRecording,
} from './activity';
import { onScreenHealthChange } from './capture';
import { sendHeartbeatNow } from './heartbeat';
import { getTimerService } from './timer';
import { serverAlignedNow } from './serverClock';
import { offerPermissionResume } from './trackingCommands';
import {
  getTrackingReadinessService,
  isInconclusiveScreenCapture,
} from './trackingReadiness';
import type { CapabilityState } from '../../shared/tracking';
import { log } from '../logger';

const CHECK_INTERVAL_MS = 2_000;
const HOOK_START_GRACE_MS = 3_000;
// User counts as "active" if they produced input within this window. Blank
// captures outside it are treated as display sleep, not revocation.
const IDLE_STATE_THRESHOLD_SEC = 30;

let timer: NodeJS.Timeout | null = null;
let removeScreenListener: (() => void) | null = null;
let removeActivityListener: (() => void) | null = null;
let checkInFlight: Promise<void> | null = null;
let activeEntryId: string | null = null;
let accruingSince: number | null = null;
let lastHealthyAt: number | null = null;

/** A verdict worth pausing for. CHECKING is not one: readiness is still
 *  re-probing, and only turns a blank screen into FAILED after several spaced
 *  probes — the confirmation this monitor used to keep a second copy of. */
function isVerdict(state: CapabilityState): boolean {
  return state === 'NEEDS_GRANT' || state === 'NEEDS_SETTINGS' || state === 'FAILED';
}

function scheduleCheck(): void {
  if (checkInFlight) return;
  checkInFlight = checkNow()
    .catch((err: unknown) => {
      log.warn('tracking permission check failed', { err: String(err) });
    })
    .finally(() => {
      checkInFlight = null;
    });
}

async function checkNow(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const timerService = getTimerService();
  const status = timerService.status();
  if (status.state !== 'RUNNING' || status.paused) {
    activeEntryId = status.state === 'RUNNING' ? status.entryId : null;
    accruingSince = null;
    lastHealthyAt = null;
    return;
  }

  // eslint-disable-next-line no-restricted-syntax -- device<->device: compared against accruingSince/lastHealthyAt from this same clock
  const now = Date.now();
  if (activeEntryId !== status.entryId || accruingSince === null) {
    activeEntryId = status.entryId;
    accruingSince = now;
    // Null, not the segment start: this is a DEVICE-clock reading and
    // `segmentStartedAt` comes from the timer's server-aligned clock. Seeding it
    // from the wrong frame made the pause cut back by the clock skew as well as
    // the unhealthy window — and on a slow device it cut back LESS than the real
    // gap, crediting unproven time. Until a check verifies healthy, we fall back
    // to the whole segment measured entirely in the timer's own frame.
    lastHealthyAt = null;
  }

  const readinessService = getTrackingReadinessService();
  let inspection = await readinessService.inspect();
  if (inspection.readiness.screenRecording !== 'READY') {
    // A single generic capture failure can be transient. Re-probe once in
    // memory before changing timer history.
    inspection = await readinessService.inspect({ verifyScreen: true });
  }

  // The timer may have moved on while readiness was awaited — stopped, paused
  // by the user or for idle, or switched to another entry. Acting on the stale
  // reading would relabel a MANUAL/IDLE pause as PERMISSION_REQUIRED, or cut
  // back an entry this check never looked at.
  const current = timerService.status();
  if (current.state !== 'RUNNING' || current.paused || current.entryId !== status.entryId) return;

  const accessibility = inspection.permissions.accessibility;
  const hookStillStarting = accessibility.recording
    && !accessibility.hookRunning
    && accruingSince !== null
    && now - accruingSince < HOOK_START_GRACE_MS
    && !inspection.accessibilityError;
  const accessibilityHealthy = inspection.readiness.accessibility === 'READY'
    && (!accessibility.recording || accessibility.hookRunning || hookStillStarting);
  const screenRecording = inspection.readiness.screenRecording;

  if (screenRecording === 'READY' && accessibilityHealthy) {
    if (!hookStillStarting) lastHealthyAt = now;
    return;
  }

  if (accessibilityHealthy) {
    if (!isVerdict(screenRecording)) return;
    // Blank captures while the user is away from the machine are a sleeping
    // display, not revocation — displays produce blank frames when powered
    // off, and plain display sleep fires no power event. A real loss keeps
    // failing once the user is active again.
    if (isInconclusiveScreenCapture(inspection, powerMonitor.getSystemIdleState(IDLE_STATE_THRESHOLD_SEC))) return;
  }

  // Elapsed time, never an instant — the timer runs on the server-aligned clock
  // and cannot interpret a device reading. Both branches below measure a gap
  // whose two ends come from the SAME clock, which is what makes the result
  // meaningful; the timer then clamps it to the segment start, so an over-long
  // gap still cuts no further back than the segment itself.
  const unhealthyForMs = lastHealthyAt !== null
    ? Math.max(0, now - lastHealthyAt)
    : Math.max(0, serverAlignedNow() - (status.segmentStartedAt ?? serverAlignedNow()));
  const paused = await timerService.pauseForPermission(unhealthyForMs);
  setActivityRecording(false, null);
  broadcast('timer:status:push', paused);
  sendHeartbeatNow();
  offerPermissionResume();
  log.warn('tracking paused because required permission became unavailable', {
    entryId: status.entryId,
    unhealthyForMs,
    blockers: inspection.readiness.blockingCapabilities,
    screenRecording,
    accessibility: inspection.readiness.accessibility,
    accessibilityError: inspection.accessibilityError,
  });
}

export function startTrackingPermissionMonitor(): void {
  if (timer || process.platform !== 'darwin') return;
  const readiness = getTrackingReadinessService();
  removeScreenListener = onScreenHealthChange((health) => {
    readiness.noteScreenHealth(health);
    scheduleCheck();
  });
  removeActivityListener = onActivityCaptureStatusChange(() => scheduleCheck());
  timer = setInterval(scheduleCheck, CHECK_INTERVAL_MS);
  scheduleCheck();
}

export function checkTrackingPermissionsNow(): void {
  scheduleCheck();
}

export function stopTrackingPermissionMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  removeScreenListener?.();
  removeActivityListener?.();
  removeScreenListener = null;
  removeActivityListener = null;
  activeEntryId = null;
  accruingSince = null;
  lastHealthyAt = null;
}

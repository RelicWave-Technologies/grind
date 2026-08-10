import { powerMonitor } from 'electron';
import { broadcast } from '../broadcast';
import {
  onActivityCaptureStatusChange,
  setActivityRecording,
} from './activity';
import { onScreenHealthChange } from './capture';
import { sendHeartbeatNow } from './heartbeat';
import { getTimerService } from './timer';
import { offerPermissionResume } from './trackingCommands';
import {
  getTrackingReadinessService,
  isInconclusiveScreenCapture,
  type ReadinessInspection,
} from './trackingReadiness';
import { log } from '../logger';

const CHECK_INTERVAL_MS = 2_000;
const HOOK_START_GRACE_MS = 3_000;
const SCREEN_FAILURE_GRACE_MS = 10_000;
const SCREEN_FAILURE_MIN_CHECKS = 3;
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
let screenFailureStartedAt: number | null = null;
let screenFailureChecks = 0;

function resetScreenFailure(): void {
  screenFailureStartedAt = null;
  screenFailureChecks = 0;
}

function isDefinitiveScreenPermissionLoss(inspection: ReadinessInspection): boolean {
  const status = inspection.permissions.screen.status;
  return status === 'denied' || status === 'restricted' || status === 'not-determined';
}

function shouldDeferScreenFailure(inspection: ReadinessInspection, now: number): boolean {
  if (inspection.readiness.screenRecording === 'READY') {
    resetScreenFailure();
    return false;
  }
  if (isDefinitiveScreenPermissionLoss(inspection)) {
    resetScreenFailure();
    return false;
  }

  // Blank captures while the user is away from the machine are a sleeping
  // display, not revocation — displays produce blank frames when powered off,
  // and plain display sleep fires no power event. Defer indefinitely without
  // consuming the confirmation window; a real loss keeps failing once the
  // user is active again.
  if (isInconclusiveScreenCapture(inspection, powerMonitor.getSystemIdleState(IDLE_STATE_THRESHOLD_SEC))) {
    resetScreenFailure();
    return true;
  }

  if (screenFailureStartedAt === null) {
    screenFailureStartedAt = now;
    screenFailureChecks = 1;
    log.warn('screen capture probe failed; waiting for confirmation before pausing', {
      status: inspection.permissions.screen.status,
      health: inspection.permissions.screen.health,
    });
    return true;
  }

  screenFailureChecks += 1;
  return now - screenFailureStartedAt < SCREEN_FAILURE_GRACE_MS || screenFailureChecks < SCREEN_FAILURE_MIN_CHECKS;
}

function scheduleCheck(): void {
  if (checkInFlight) return;
  checkInFlight = checkNow().finally(() => {
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
    resetScreenFailure();
    return;
  }

  const now = Date.now();
  if (activeEntryId !== status.entryId || accruingSince === null) {
    activeEntryId = status.entryId;
    accruingSince = now;
    lastHealthyAt = status.segmentStartedAt ?? now;
    resetScreenFailure();
  }

  const readinessService = getTrackingReadinessService();
  let inspection = await readinessService.inspect();
  if (inspection.readiness.screenRecording !== 'READY') {
    // A single generic capture failure can be transient. Re-probe once in
    // memory before changing timer history.
    inspection = await readinessService.inspect({ verifyScreen: true });
  }

  const accessibility = inspection.permissions.accessibility;
  const hookStillStarting = accessibility.recording
    && !accessibility.hookRunning
    && accruingSince !== null
    && now - accruingSince < HOOK_START_GRACE_MS
    && !inspection.accessibilityError;
  const accessibilityHealthy = inspection.readiness.accessibility === 'READY'
    && (!accessibility.recording || accessibility.hookRunning || hookStillStarting);
  const screenHealthy = inspection.readiness.screenRecording === 'READY';
  const healthy = screenHealthy && accessibilityHealthy;

  if (healthy) {
    if (!hookStillStarting) lastHealthyAt = now;
    resetScreenFailure();
    return;
  }

  if (!screenHealthy && accessibilityHealthy && shouldDeferScreenFailure(inspection, now)) {
    return;
  }

  const cutAt = lastHealthyAt ?? now;
  const paused = await timerService.pauseForPermission(cutAt);
  setActivityRecording(false, null);
  broadcast('timer:status:push', paused);
  sendHeartbeatNow();
  offerPermissionResume();
  log.warn('tracking paused because required permission became unavailable', {
    entryId: status.entryId,
    cutAt,
    blockers: inspection.readiness.blockingCapabilities,
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

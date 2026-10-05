import type { DesktopPermissionSnapshot } from '@grind/types';
import type {
  BlockingCapability,
  CapabilityState,
  TrackingReadiness,
} from '../../shared/tracking';
import { getActivityCaptureStatus, type ActivityCaptureStatus } from './activity';
import { getScreenHealth } from './capture';
import { probeScreenCapture } from './capture/capture';
import {
  screenStatus,
  screenUiState,
  type CaptureHealth,
  type ScreenStatus,
} from './permissions';
import { getPreferences, noteScreenRestartAdvice } from './preferences';
import { log } from '../logger';

interface TrackingReadinessDeps {
  platform: NodeJS.Platform;
  now: () => number;
  screenStatus: () => ScreenStatus;
  screenHealth: () => CaptureHealth;
  accessibilityStatus: () => ActivityCaptureStatus;
  probeScreen: () => Promise<CaptureHealth>;
  /** True when a previous launch already told the user to relaunch for screen
   *  recording. Read once at construction — a value written during THIS launch
   *  must not escalate the advice it just produced. */
  restartAlreadyAdvised: () => boolean;
  /** Persist (`at`) or clear (`null`) the "we advised a relaunch" marker. */
  noteRestartAdvice: (at: number | null) => void;
}

export interface ReadinessInspection {
  readiness: TrackingReadiness;
  permissions: DesktopPermissionSnapshot;
  accessibilityError: string | null;
}

function defaultDeps(): TrackingReadinessDeps {
  return {
    platform: process.platform,
    now: () => Date.now(),
    screenStatus,
    screenHealth: getScreenHealth,
    accessibilityStatus: getActivityCaptureStatus,
    probeScreen: probeScreenCapture,
    restartAlreadyAdvised: () => getPreferences().screenRecovery.advisedRestartAt !== null,
    noteRestartAdvice: (at) => void noteScreenRestartAdvice(at),
  };
}

function screenCapability(
  status: ScreenStatus,
  health: CaptureHealth,
  probeHealthy: boolean | null,
  restartAlreadyTried: boolean,
): CapabilityState {
  if (status === 'not-determined' || status === 'unknown') return 'NEEDS_GRANT';
  if (status === 'denied' || status === 'restricted') return 'NEEDS_SETTINGS';
  if (probeHealthy === true || health === 'ok') return 'READY';
  if (probeHealthy === false || health === 'empty' || health === 'error' || health === 'no-permission') {
    // macOS says granted and capture is still blank. A relaunch is the usual
    // cure — the grant is only picked up at launch — but only the FIRST time.
    // If we already sent this user round once and the capture is still blank,
    // the grant itself is stale and no number of relaunches will change that.
    return restartAlreadyTried ? 'NEEDS_REGRANT' : 'NEEDS_RESTART';
  }
  // Granted, nothing has failed, and no probe has run yet. That is "not known",
  // not "broken" — reporting it as NEEDS_RESTART is what told people to relaunch
  // an app whose permission was already fine.
  return 'CHECKING';
}

function accessibilityCapability(status: ActivityCaptureStatus): CapabilityState {
  if (!status.trusted) return 'NEEDS_GRANT';
  if (!status.ready) return 'NEEDS_RESTART';
  if (status.lastHookError) return 'FAILED';
  return 'READY';
}

export class TrackingBlockedError extends Error {
  readonly code = 'TRACKING_PERMISSIONS_REQUIRED' as const;

  constructor(readonly readiness: TrackingReadiness) {
    super('Tracking permissions are required');
    this.name = 'TrackingBlockedError';
  }
}

export function isTrackingBlockedError(error: unknown): error is TrackingBlockedError {
  return error instanceof TrackingBlockedError;
}

export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

/**
 * True when an unhealthy inspection is explainable by a display that is not
 * rendering rather than by a lost permission. Displays produce blank captures
 * while powered off, and macOS fires no power event for plain display sleep
 * (unlike lock/suspend) — so an "empty" capture while the user is not actively
 * using the machine must not be treated as mid-session revocation. A real
 * revocation keeps failing after the user is active again.
 */
export function isInconclusiveScreenCapture(
  inspection: ReadinessInspection,
  idleState: SystemIdleState,
): boolean {
  if (idleState === 'active') return false;
  const { readiness, permissions } = inspection;
  return readiness.blockingCapabilities.length === 1
    && readiness.blockingCapabilities[0] === 'SCREEN_RECORDING'
    && permissions.screen.status === 'granted'
    && permissions.screen.health === 'empty';
}

/** Log a non-ready verdict at most once per distinct shape, so a permanent
 *  blocker does not flood the log at the poll rate. */
let lastVerdictKey = '';
function logReadinessVerdict(fields: Record<string, unknown>): void {
  const key = JSON.stringify(fields);
  if (key === lastVerdictKey) return;
  lastVerdictKey = key;
  log.warn('tracking readiness not ready', fields);
}

export function createTrackingReadinessService(deps: TrackingReadinessDeps) {
  let screenProbeHealthy: boolean | null = null;
  /**
   * Whether a relaunch was advised BEFORE this launch began.
   *
   * Captured once, here, rather than read on each inspection: the marker gets
   * written the moment we first say NEEDS_RESTART, and re-reading it would
   * escalate our own advice thirty seconds later without the user having
   * restarted anything.
   */
  let restartAdvisedBeforeThisLaunch = deps.restartAlreadyAdvised();

  async function inspect(opts: { verifyScreen?: boolean } = {}): Promise<ReadinessInspection> {
    const rawScreenStatus = deps.screenStatus();
    let rawScreenHealth = deps.screenHealth();
    const rawAccessibility = deps.accessibilityStatus();

    if (deps.platform !== 'darwin') {
      const readiness: TrackingReadiness = {
        ready: true,
        checkedAt: new Date(deps.now()).toISOString(),
        screenRecording: 'NOT_REQUIRED',
        accessibility: 'NOT_REQUIRED',
        blockingCapabilities: [],
      };
      return {
        readiness,
        permissions: {
          screen: { status: 'granted', health: 'ok', state: 'ok' },
          accessibility: {
            trusted: true,
            ready: true,
            recording: rawAccessibility.recording,
            capturing: rawAccessibility.capturing,
            hookRunning: rawAccessibility.hookRunning,
          },
        },
        accessibilityError: null,
      };
    }

    if (rawScreenHealth === 'ok') screenProbeHealthy = true;
    if (rawScreenStatus !== 'granted') screenProbeHealthy = false;

    if (opts.verifyScreen && rawScreenStatus === 'granted' && screenProbeHealthy !== true) {
      rawScreenHealth = await deps.probeScreen();
      screenProbeHealthy = rawScreenHealth === 'ok';
    }

    const screenRecording = screenCapability(
      rawScreenStatus,
      rawScreenHealth,
      screenProbeHealthy,
      restartAdvisedBeforeThisLaunch,
    );

    // Screen capture works: forget everything we advised. A failure after this
    // is a fresh problem and deserves the ordinary "restart" answer first,
    // not an escalation inherited from weeks ago.
    if (screenRecording === 'READY') {
      restartAdvisedBeforeThisLaunch = false;
      deps.noteRestartAdvice(null);
    } else if (screenRecording === 'NEEDS_RESTART') {
      // Remember that we said it, so the next launch can tell whether it helped.
      deps.noteRestartAdvice(deps.now());
    }
    const accessibility = accessibilityCapability(rawAccessibility);
    const effectiveScreenHealth: CaptureHealth = screenProbeHealthy === true ? 'ok' : rawScreenHealth;
    const blockingCapabilities: BlockingCapability[] = [];
    if (screenRecording !== 'READY') blockingCapabilities.push('SCREEN_RECORDING');
    if (accessibility !== 'READY') blockingCapabilities.push('ACCESSIBILITY');

    if (blockingCapabilities.length > 0) {
      // The verdict alone is undiagnosable in the field: a user reporting
      // "it says Restart" left no trace at all in the log before this.
      logReadinessVerdict({
        screenRecording,
        accessibility,
        screenStatus: rawScreenStatus,
        screenHealth: effectiveScreenHealth,
        screenProbeHealthy,
        accessibilityTrusted: rawAccessibility.trusted,
        accessibilityReady: rawAccessibility.ready,
        hookRunning: rawAccessibility.hookRunning,
        lastHookError: rawAccessibility.lastHookError,
      });
    }

    return {
      readiness: {
        ready: blockingCapabilities.length === 0,
        checkedAt: new Date(deps.now()).toISOString(),
        screenRecording,
        accessibility,
        blockingCapabilities,
      },
      permissions: {
        screen: {
          status: rawScreenStatus,
          health: effectiveScreenHealth,
          state: screenUiState(rawScreenStatus, effectiveScreenHealth),
        },
        accessibility: {
          trusted: rawAccessibility.trusted,
          ready: rawAccessibility.ready,
          recording: rawAccessibility.recording,
          capturing: rawAccessibility.capturing,
          hookRunning: rawAccessibility.hookRunning,
        },
      },
      accessibilityError: rawAccessibility.lastHookError,
    };
  }

  async function assertCanAccrue(): Promise<void> {
    const { readiness } = await inspect({ verifyScreen: true });
    if (!readiness.ready) throw new TrackingBlockedError(readiness);
  }

  async function requestScreenAccess(): Promise<ReadinessInspection> {
    const health = await deps.probeScreen();
    screenProbeHealthy = health === 'ok';
    return inspect({ verifyScreen: true });
  }

  function noteScreenHealth(health: CaptureHealth): void {
    if (health === 'ok') screenProbeHealthy = true;
    else if (health !== 'unknown') screenProbeHealthy = false;
  }

  function invalidateScreenProbe(): void {
    screenProbeHealthy = null;
  }

  return { inspect, assertCanAccrue, requestScreenAccess, noteScreenHealth, invalidateScreenProbe };
}

let singleton: ReturnType<typeof createTrackingReadinessService> | null = null;

export function getTrackingReadinessService() {
  if (!singleton) singleton = createTrackingReadinessService(defaultDeps());
  return singleton;
}

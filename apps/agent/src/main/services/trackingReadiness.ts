import type { DesktopPermissionSnapshot } from '@grind/types';
import type {
  BlockingCapability,
  CapabilityState,
  TrackingReadiness,
} from '../../shared/tracking';
import {
  getActivityCaptureStatus,
  retryActivityHook,
  startActivityCapture,
  type ActivityCaptureStatus,
} from './activity';
import { getScreenHealth } from './capture';
import { probeScreenCapture } from './capture/capture';
import {
  screenStatus,
  screenUiState,
  type CaptureHealth,
  type ScreenStatus,
} from './permissions';
import { log } from '../logger';

// A blank probe is re-run at most this often while the screen is unverified,
// so the polling surfaces converge without hammering desktopCapturer.
const SCREEN_REPROBE_INTERVAL_MS = 5_000;
// Consecutive blank probes before "still checking" becomes "not working".
const SCREEN_FAILED_AFTER_PROBES = 3;

interface TrackingReadinessDeps {
  platform: NodeJS.Platform;
  /** Device clock: probe spacing is a device↔device gap. */
  now: () => number;
  screenStatus: () => ScreenStatus;
  screenHealth: () => CaptureHealth;
  accessibilityStatus: () => ActivityCaptureStatus;
  startActivityCapture: () => void;
  /** Clear a stored hook failure and try the hook once now. */
  retryActivityHook: () => ActivityCaptureStatus;
  probeScreen: () => Promise<CaptureHealth>;
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
    startActivityCapture: () => startActivityCapture(),
    retryActivityHook: () => retryActivityHook(),
    probeScreen: probeScreenCapture,
  };
}

function screenCapability(status: ScreenStatus, probeHealthy: boolean | null, failedProbes: number): CapabilityState {
  if (status === 'not-determined' || status === 'unknown') return 'NEEDS_GRANT';
  if (status === 'denied' || status === 'restricted') return 'NEEDS_SETTINGS';
  if (probeHealthy === true) return 'READY';
  // Granted but not seen working. getMediaAccessStatus('screen') reads the TCC
  // grant this process already holds, so a restart cannot fix a blank probe —
  // slow Macs just return blank frames from the first captures of a fresh
  // process. Keep re-probing; only a failure that persists is reported, and
  // even then as something to check, not something to restart.
  return failedProbes >= SCREEN_FAILED_AFTER_PROBES ? 'FAILED' : 'CHECKING';
}

function accessibilityCapability(status: ActivityCaptureStatus): CapabilityState {
  if (!status.trusted) return 'NEEDS_GRANT';
  // Trusted, but the activity service would not start in-process (it is
  // retried on every inspect) or the hook was refused (retried on Check again).
  if (!status.ready || status.lastHookError) return 'FAILED';
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

export function createTrackingReadinessService(deps: TrackingReadinessDeps) {
  let screenProbeHealthy: boolean | null = null;
  // Latest failed reading from a probe or the capture loop. A throttled inspect
  // reports it instead of a stale or 'unknown' capture-loop value.
  let screenFailure: CaptureHealth | null = null;
  let screenProbeFailures = 0;
  let lastProbeAt: number | null = null;
  let probeInFlight: Promise<CaptureHealth> | null = null;
  let lastActivityStartError = '';
  let lastVerdictKey = '';

  /**
   * One probe at a time, shared by every caller. The prompt (1s), Settings
   * (4s), the monitor (2s) and the resume poll (2s) all verify the screen; when
   * each started its own probe — and the spacing was only stamped after the
   * await — three overlapping blank readings landed within ~2s and a slow Mac
   * went straight to FAILED. Stamped before awaiting, joined while in flight,
   * each probe counts once.
   */
  function probe(): Promise<CaptureHealth> {
    if (probeInFlight) return probeInFlight;
    lastProbeAt = deps.now();
    probeInFlight = (async () => {
      try {
        const health = await deps.probeScreen();
        noteScreenHealth(health);
        if (health !== 'ok') screenProbeFailures += 1;
        return health;
      } finally {
        probeInFlight = null;
      }
    })();
    return probeInFlight;
  }

  /** Log a non-ready verdict once per verdict — not per probe count or other
   *  detail — so a standing blocker does not add a line at the poll rate. */
  function logReadinessVerdict(verdict: string, fields: Record<string, unknown>): void {
    if (verdict === lastVerdictKey) return;
    lastVerdictKey = verdict;
    log.warn('tracking readiness not ready', fields);
  }

  function probeDue(): boolean {
    return lastProbeAt === null || deps.now() - lastProbeAt >= SCREEN_REPROBE_INTERVAL_MS;
  }

  /**
   * Accessibility trust is read live, so a grant made while Timo is running is
   * usable at once. Boot started the activity service only if trust already
   * existed then; start it now rather than asking for a restart.
   */
  function startActivityCaptureInProcess(): ActivityCaptureStatus {
    try {
      deps.startActivityCapture();
    } catch (err) {
      const message = String(err);
      if (message !== lastActivityStartError) {
        lastActivityStartError = message;
        log.warn('activity capture failed to start after accessibility grant', { err: message });
      }
    }
    return deps.accessibilityStatus();
  }

  async function inspect(opts: { verifyScreen?: boolean; retryHook?: boolean } = {}): Promise<ReadinessInspection> {
    const rawScreenStatus = deps.screenStatus();
    const rawScreenHealth = deps.screenHealth();
    let rawAccessibility = deps.accessibilityStatus();

    // A stored hook failure otherwise stands until quit: the hook is only
    // started while recording, and recording cannot resume past the failure.
    if (opts.retryHook && rawAccessibility.trusted && rawAccessibility.ready && rawAccessibility.lastHookError) {
      rawAccessibility = deps.retryActivityHook();
    }

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

    if (rawAccessibility.trusted && !rawAccessibility.ready) {
      rawAccessibility = startActivityCaptureInProcess();
    }

    if (rawScreenHealth === 'ok') noteScreenHealth('ok');
    if (rawScreenStatus !== 'granted') {
      screenProbeHealthy = false;
      screenFailure = null;
      screenProbeFailures = 0;
    }

    if (opts.verifyScreen && rawScreenStatus === 'granted' && screenProbeHealthy !== true && (probeInFlight || probeDue())) {
      await probe();
    }

    const screenRecording = screenCapability(rawScreenStatus, screenProbeHealthy, screenProbeFailures);
    const accessibility = accessibilityCapability(rawAccessibility);
    const effectiveScreenHealth: CaptureHealth = screenProbeHealthy === true ? 'ok' : screenFailure ?? rawScreenHealth;
    const blockingCapabilities: BlockingCapability[] = [];
    if (screenRecording !== 'READY') blockingCapabilities.push('SCREEN_RECORDING');
    if (accessibility !== 'READY') blockingCapabilities.push('ACCESSIBILITY');
    const accessibilityError = rawAccessibility.lastHookError
      ?? (rawAccessibility.trusted && !rawAccessibility.ready && lastActivityStartError ? lastActivityStartError : null);

    if (blockingCapabilities.length === 0) {
      lastVerdictKey = '';
    } else {
      // The verdict alone is undiagnosable in the field: a user reporting
      // "it says Restart" left no trace at all in the log before this.
      logReadinessVerdict(`${screenRecording}|${accessibility}`, {
        screenRecording,
        accessibility,
        screenStatus: rawScreenStatus,
        screenHealth: effectiveScreenHealth,
        screenProbeHealthy,
        screenProbeFailures,
        accessibilityTrusted: rawAccessibility.trusted,
        accessibilityReady: rawAccessibility.ready,
        hookRunning: rawAccessibility.hookRunning,
        accessibilityError,
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
      accessibilityError,
    };
  }

  /** Verify now, ignoring the re-probe spacing and the hook's retry backoff —
   *  for an explicit user action ("Check again", Start, Resume). */
  function recheck(): Promise<ReadinessInspection> {
    lastProbeAt = null;
    return inspect({ verifyScreen: true, retryHook: true });
  }

  async function assertCanAccrue(): Promise<void> {
    const { readiness } = await recheck();
    if (!readiness.ready) throw new TrackingBlockedError(readiness);
  }

  async function requestScreenAccess(): Promise<ReadinessInspection> {
    await probe();
    return inspect({ verifyScreen: true });
  }

  function noteScreenHealth(health: CaptureHealth): void {
    if (health === 'ok') {
      screenProbeHealthy = true;
      screenFailure = null;
      screenProbeFailures = 0;
    } else if (health !== 'unknown') {
      screenProbeHealthy = false;
      screenFailure = health;
    }
  }

  return { inspect, recheck, assertCanAccrue, requestScreenAccess, noteScreenHealth };
}

let singleton: ReturnType<typeof createTrackingReadinessService> | null = null;

export function getTrackingReadinessService() {
  if (!singleton) singleton = createTrackingReadinessService(defaultDeps());
  return singleton;
}

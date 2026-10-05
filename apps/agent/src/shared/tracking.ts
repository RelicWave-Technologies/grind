export type CapabilityState =
  | 'NOT_REQUIRED'
  | 'READY'
  /** Granted, but not yet verified this session. NOT a diagnosis — the absence
   *  of a reading was previously reported as NEEDS_RESTART, which sent people
   *  round a relaunch loop that could not resolve anything. */
  | 'CHECKING'
  | 'NEEDS_GRANT'
  | 'NEEDS_SETTINGS'
  | 'NEEDS_RESTART'
  /**
   * macOS says the permission is granted, but capture keeps coming back empty
   * AND a relaunch has already been tried without fixing it.
   *
   * This is a stale TCC grant: the entry in System Settings survives, so
   * `CGPreflightScreenCaptureAccess` answers yes, while the capture the app
   * actually gets is blank. Only removing Timo from Screen Recording and adding
   * it back clears it. Reporting this as NEEDS_RESTART is what put a user
   * through five relaunches in two minutes, each one ending exactly where it
   * started.
   */
  | 'NEEDS_REGRANT'
  | 'FAILED';

export type BlockingCapability = 'SCREEN_RECORDING' | 'ACCESSIBILITY';

export interface TrackingReadiness {
  ready: boolean;
  checkedAt: string;
  screenRecording: CapabilityState;
  accessibility: CapabilityState;
  blockingCapabilities: BlockingCapability[];
}

export type TimerPauseReason = 'IDLE' | 'MANUAL' | 'PERMISSION_REQUIRED';

export type TimerStatus =
  | { state: 'IDLE'; workedMs: number }
  | {
      state: 'RUNNING';
      entryId: string;
      revision: number;
      larkTaskGuid: string | null;
      startedAt: number;
      segmentStartedAt: number | null;
      workedMs: number;
      paused: boolean;
      pauseReason: TimerPauseReason | null;
    };

export type TrackingCommandResult =
  | { ok: true; status: TimerStatus }
  | {
      ok: false;
      reason: 'PERMISSIONS_REQUIRED';
      status: TimerStatus;
      readiness: TrackingReadiness;
    };

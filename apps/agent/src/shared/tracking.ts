export type CapabilityState =
  | 'NOT_REQUIRED'
  | 'READY'
  /** Granted, but not yet verified this session — including a probe that came
   *  back blank and is being retried. NOT a diagnosis: a granted Screen
   *  Recording status is already effective in this process, so a restart
   *  cannot fix a blank probe, and offering one sent people round a loop. */
  | 'CHECKING'
  | 'NEEDS_GRANT'
  | 'NEEDS_SETTINGS'
  /** Accessibility is trusted but the activity service failed to start in
   *  this process. The only state a restart is offered for. */
  | 'NEEDS_RESTART'
  /** Granted, yet it keeps failing: screen probes stay blank, or macOS refused
   *  the input hook (Input Monitoring). Neither is fixed by a restart. */
  | 'FAILED';

export type BlockingCapability = 'SCREEN_RECORDING' | 'ACCESSIBILITY';

export interface TrackingReadiness {
  ready: boolean;
  checkedAt: string;
  screenRecording: CapabilityState;
  accessibility: CapabilityState;
  blockingCapabilities: BlockingCapability[];
  /** Blockers whose verdict already stood before a permission restart less
   *  than two minutes ago. A second restart would only repeat the first, so
   *  the UI offers "Check again" instead. */
  restartDidNotHelp?: BlockingCapability[];
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

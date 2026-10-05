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
  /** Granted, yet it keeps failing: screen probes stay blank, or the input
   *  hook / activity service would not start although Accessibility is
   *  trusted. The UI offers Check again first; Restart only after that. */
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

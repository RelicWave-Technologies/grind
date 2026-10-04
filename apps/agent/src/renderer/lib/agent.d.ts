import type { AgentBridge } from '../../preload';
import type {
  TimerStatus,
  TrackingCommandResult,
  TrackingReadiness,
} from '../../shared/tracking';

export type { TimerRecoveryNotice, TodayEntry, TodaySegment, UpdateStatus } from '../../preload';

declare global {
  interface Window {
    agent: AgentBridge;
  }
}

export type { TimerStatus, TrackingCommandResult, TrackingReadiness };

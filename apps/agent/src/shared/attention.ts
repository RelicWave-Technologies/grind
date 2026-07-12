import type { TrackingCommandResult } from './tracking';

export type PermissionIntent = 'START_TASK' | 'RESUME_ENTRY' | 'SETUP';

export type AttentionPrompt =
  | { kind: 'NONE' }
  | { kind: 'IDLE'; promptId: string; idleStartedAt: number }
  | {
      kind: 'AWAY';
      promptId: string;
      larkTaskGuid: string | null;
      stoppedAt: number;
      reason: 'suspend' | 'lock';
    }
  | {
      kind: 'PERMISSION';
      promptId: string;
      intent: PermissionIntent;
      presentation: 'FRONT' | 'YIELDED_TO_SETTINGS';
    };

export type AttentionAction =
  | 'IDLE_CONTINUE'
  | 'IDLE_BREAK'
  | 'AWAY_RESUME'
  | 'AWAY_DISMISS'
  | 'PERMISSION_RETRY'
  | 'PERMISSION_CLOSE';

export type AttentionActionResult =
  | { ok: true; command?: TrackingCommandResult | null }
  | { ok: false; reason: 'STALE_PROMPT' | 'ACTION_NOT_ALLOWED' };

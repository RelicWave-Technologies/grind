import { decideManualTimeRequest } from '../manualTime/decision';
import { type ApprovalAction } from './cards';

/**
 * Dashboard-side decision wrapper. Shares the same locked state machine as
 * Lark card clicks; this file only adapts dashboard auth/scope inputs.
 */
export interface DecideByUserResult {
  status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'CANCELLED';
  timeEntryId: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  noop: 'already_decided' | 'cancelled' | 'not_found' | 'forbidden' | 'self_approval_forbidden' | 'stale_card' | null;
}

export async function decideByUser(args: {
  requestId: string;
  action: ApprovalAction;
  deciderUserId: string;
  deciderRole: string;
  scopeUserIds: string[];
  reason?: string;
  now?: Date;
}): Promise<DecideByUserResult | null> {
  const result = await decideManualTimeRequest({
    requestId: args.requestId,
    action: args.action,
    source: 'DASHBOARD',
    deciderUserId: args.deciderUserId,
    deciderRole: args.deciderRole,
    scopeUserIds: args.scopeUserIds,
    reason: args.reason,
    now: args.now,
  });
  if (!result) return null;
  return {
    status: result.status,
    timeEntryId: result.timeEntryId,
    decidedAt: result.decidedAt,
    decidedReason: result.decidedReason,
    noop: result.noop,
  };
}

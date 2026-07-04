import { decideManualTimeRequest } from '../manualTime/decision';
import { type ApprovalAction } from './cards';

/**
 * Lark-card decision wrapper. The actual state machine lives in
 * manualTime/decision so dashboard and Lark cannot diverge.
 */
export interface DecideResult {
  card: Record<string, unknown>;
  status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'CANCELLED';
  timeEntryId: string | null;
  noop: 'already_decided' | 'not_found' | 'forbidden' | 'self_approval_forbidden' | 'cancelled' | 'stale_card' | null;
}

export async function decideRequest(args: {
  requestId: string;
  action: ApprovalAction;
  decidedByOpenId: string;
  cardId?: string;
  version?: number;
  now?: Date;
}): Promise<DecideResult | null> {
  const result = await decideManualTimeRequest({
    requestId: args.requestId,
    action: args.action,
    source: 'LARK_CARD',
    decidedByOpenId: args.decidedByOpenId,
    cardId: args.cardId,
    version: args.version,
    now: args.now,
  });
  if (!result) return null;
  return {
    card: result.card,
    status: result.status,
    timeEntryId: result.timeEntryId,
    noop: result.noop,
  };
}

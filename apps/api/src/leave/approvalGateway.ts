import { hasLarkCredentials } from '../lark/config';

/**
 * How Lark's approval statuses map onto ours.
 *
 * This file used to hold a whole approval gateway — submit a request, poll it
 * back, two adapters behind a seam. None of it survived contact with the
 * tenant: creating a leave instance needs a leave-type id that this Lark
 * exposes nowhere (the approval definition returns an empty option list,
 * instances echo only the display name, and the list-leave-types API belongs to
 * CoreHR, which this tenant does not have). Timo therefore mirrors leave rather
 * than raising it, and the only piece worth keeping is the vocabulary mapping.
 *
 * Kept as a seam of one function rather than folded into the ingester because
 * it is the whole of the integration worth testing in isolation.
 */

/**
 * What an approver has decided.
 *
 * `UNKNOWN` is deliberately distinct from `PENDING`: an instance we cannot read
 * — deleted, scope revoked, a status Lark adds later — must not be mistaken for
 * one still waiting, or it is never chased up.
 */
export type ExternalDecision = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'UNKNOWN';

export function decisionFromLarkStatus(status: string | undefined | null): ExternalDecision {
  switch ((status ?? '').toUpperCase()) {
    case 'PENDING':
      return 'PENDING';
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    // Lark spells it with one L, and a deleted instance is gone for good —
    // both mean "nobody is going to decide this".
    case 'CANCELED':
    case 'CANCELLED':
    case 'DELETED':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

let testOverride: boolean | null = null;

/**
 * Force the answer in tests.
 *
 * Needed because `src/env.ts` runs `import 'dotenv/config'`, which repopulates
 * `process.env` from the real .env AFTER the suite's setup file has deleted the
 * Lark keys. That neutering therefore only holds for values read at import
 * time, and this one is read per call. An explicit seam beats a global the
 * suite cannot actually control.
 */
export function setLeaveDecidedInLarkForTests(value: boolean | null): void {
  testOverride = value;
}

/**
 * Is leave owned by Lark? True whenever an approval code is configured.
 *
 * The UI uses this to decide whether to offer anything, and the service uses it
 * to refuse a local application. All-or-nothing on purpose: a half-configured
 * Lark would accept requests that reach nobody.
 */
export function leaveDecidedInLark(): boolean {
  if (testOverride !== null) return testOverride;
  return Boolean(process.env.LARK_LEAVE_APPROVAL_CODE?.trim()) && hasLarkCredentials();
}

import { roundToHalfDay, type LeaveLedgerKind } from '@grind/types';

/**
 * The paid-leave balance.
 *
 * A balance is never a number we decrement. It is the sum of an append-only
 * ledger, and that single decision buys most of what this feature needs:
 *
 *  - **Retries are no-ops.** Every entry carries a `sourceKey`; approving the
 *    same request twice writes the same key twice and the second write loses.
 *    A card clicked twice cannot silently cost someone a day.
 *  - **Cancellation is visible.** Giving a day back is a reversing entry with
 *    a reason, not an add-back nobody can audit.
 *  - **Carry-forward is not a feature.** It is what happens when nothing
 *    resets — the balance is simply the sum to date.
 *  - **"Why is mine 1.5?" is answerable.** The statement is the answer.
 *  - **A bug is fixed by recomputing**, not by guessing what the counter
 *    should have been.
 *
 * This module is pure. The projection below is the only place a balance is
 * ever produced, so there is exactly one definition of the number.
 */

export interface LeaveLedgerEntry {
  kind: LeaveLedgerKind;
  /** Signed days: +1 accrual, -0.5 consumption, ± adjustment. */
  days: number;
  /** Business date the entry counts from (YYYY-MM-DD). */
  effectiveOn: string;
  reason?: string | null;
}

export interface LeaveBalance {
  balanceDays: number;
  accruedDays: number;
  consumedDays: number;
  adjustedDays: number;
}

/**
 * Sum the ledger as of a date (inclusive). Entries dated after `asOf` are
 * ignored, which is what makes a month-end report reproducible: re-running
 * August's report in December must produce August's balance, not today's.
 */
export function projectBalance(
  entries: readonly LeaveLedgerEntry[],
  asOf?: string,
): LeaveBalance {
  let accrued = 0;
  let consumed = 0;
  let adjusted = 0;

  for (const e of entries) {
    if (asOf && e.effectiveOn > asOf) continue;
    if (e.kind === 'ACCRUAL') accrued += e.days;
    else if (e.kind === 'CONSUMPTION') consumed += e.days;
    else adjusted += e.days;
  }

  // Round once, at the edge. Halves are exact in binary floating point, so this
  // is belt-and-braces against a bad input rather than a correction of drift.
  const balanceDays = roundToHalfDay(accrued + consumed + adjusted);
  return {
    balanceDays,
    accruedDays: roundToHalfDay(accrued),
    // Reported positive — "1.5 days consumed" reads better than "-1.5".
    consumedDays: roundToHalfDay(-consumed),
    adjustedDays: roundToHalfDay(adjusted),
  };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/**
 * Accrual is where this kind of feature quietly rots. A monthly cron that adds
 * +1 fails silently in both directions: miss a run and someone is short a day
 * forever, retry a run and someone gains one. Nobody notices for a year.
 *
 * So accrual is not an event we fire — it is a function of time that we
 * *materialise*. The entry for a month is keyed `accrual:<userId>:<YYYY-MM>`,
 * which makes writing it twice a no-op and lets a missed month be backfilled
 * later, correctly dated. Whether it runs on a schedule or lazily on read then
 * stops mattering, which is the point.
 */
export interface AccrualPolicy {
  monthlyAccrualDays: number;
  accrueOnJoinMonth: boolean;
  carryForward: boolean;
  carryForwardCapDays: number | null;
}

export interface AccrualDue {
  month: string; // YYYY-MM
  effectiveOn: string; // first of that month
  days: number;
  sourceKey: string;
}

/** `YYYY-MM` for a `YYYY-MM-DD`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** First calendar day of a `YYYY-MM`. */
export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

/** Next `YYYY-MM` after the given one. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const nextY = m === 12 ? y! + 1 : y!;
  const nextM = m === 12 ? 1 : m! + 1;
  return `${String(nextY).padStart(4, '0')}-${String(nextM).padStart(2, '0')}`;
}

/**
 * Every accrual entry this person should have between joining and `asOf`,
 * whether or not it has been written yet. The caller upserts them by
 * `sourceKey`; already-present months collide and are skipped.
 *
 * Deriving the full set rather than "the one for this month" is what makes a
 * missed month self-heal — the next run notices the gap and fills it.
 */
export function accrualsDue(input: {
  userId: string;
  joinedOn: string; // YYYY-MM-DD
  asOf: string; // YYYY-MM-DD
  policy: AccrualPolicy;
}): AccrualDue[] {
  const { policy } = input;
  if (policy.monthlyAccrualDays <= 0) return [];
  if (input.asOf < input.joinedOn) return [];

  const joinMonth = monthOf(input.joinedOn);
  const lastMonth = monthOf(input.asOf);
  let month = policy.accrueOnJoinMonth ? joinMonth : nextMonth(joinMonth);

  const out: AccrualDue[] = [];
  // 1200 months is 100 years — a backstop, never a real bound.
  for (let i = 0; i < 1200 && month <= lastMonth; i++) {
    out.push({
      month,
      effectiveOn: firstOfMonth(month),
      days: policy.monthlyAccrualDays,
      sourceKey: accrualSourceKey(input.userId, month),
    });
    month = nextMonth(month);
  }
  return out;
}

/** The idempotency key that makes a retried accrual a no-op. */
export function accrualSourceKey(userId: string, month: string): string {
  return `accrual:${userId}:${month}`;
}

/** The idempotency key tying a consumption entry to the request that caused it. */
export function consumptionSourceKey(requestId: string): string {
  return `leave:${requestId}`;
}

/** The key for the reversal written when an approved request is cancelled. */
export function reversalSourceKey(requestId: string): string {
  return `leave-reversal:${requestId}`;
}

// ---------------------------------------------------------------------------
// Affordability
// ---------------------------------------------------------------------------

export interface AffordabilityInput {
  balanceDays: number;
  chargedDays: number;
  allowNegativeBalance: boolean;
}

export interface Affordability {
  sufficient: boolean;
  balanceAfterDays: number;
  shortfallDays: number;
}

/**
 * Can this request be afforded? Checked at APPROVAL, not only at submission —
 * two requests submitted while one is pending both look affordable against the
 * same balance, and only the approving transaction sees the truth.
 */
export function affordability(input: AffordabilityInput): Affordability {
  const after = roundToHalfDay(input.balanceDays - input.chargedDays);
  const shortfall = after < 0 ? roundToHalfDay(-after) : 0;
  return {
    sufficient: input.allowNegativeBalance || after >= 0,
    balanceAfterDays: after,
    shortfallDays: shortfall,
  };
}

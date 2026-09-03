import { roundToHalfDay } from '@grind/types';

/**
 * Which approved paid-leave days were not actually covered by a balance.
 *
 * Paid leave is only paid while there is something to pay it from. Timo cannot
 * refuse a leave that a manager already granted in Lark — by the time the
 * approval reaches us the person has taken the day — so the balance rule
 * cannot be enforced at the gate. It is enforced here instead, in the record:
 * the days a balance covered stay Paid Leave, and the days past it are Leave
 * Without Pay.
 *
 * A day is funded as far as the balance reaches and no further, which is the
 * only rule that does not throw away change. A full day met by half a day of
 * balance is half paid and half not — refusing to split it would either bill a
 * whole day nobody had, or leave the half day sitting in the balance where a
 * later, cheaper day would spend it and put the paid days out of order.
 *
 * This decides a *label*, never a charge. The ledger still debits every
 * approved day and is still allowed to run negative, so the two numbers say
 * different things on purpose — the balance says how far someone is overdrawn,
 * and the unfunded days say which ones the balance did not reach.
 *
 * Pure, and separate from the Working Calendar, because the calendar answers
 * "was this person expected to work" from three sources it owns outright. The
 * funding question needs a fourth — the ledger — and threading a running
 * balance through a class built to be queried in any order would make the
 * answer depend on the order you asked.
 */

export interface LeaveCredit {
  userId: string;
  /** YYYY-MM-DD the credit counts from. */
  effectiveOn: string;
  /** Signed days: accruals positive, adjustments either way. */
  days: number;
}

export interface ChargeableLeaveDay {
  userId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** What the day costs a balance: 1 for a full day, 0.5 for a half. */
  cost: number;
}

export interface LeaveFundingInput {
  credits: readonly LeaveCredit[];
  leaveDays: readonly ChargeableLeaveDay[];
  /**
   * First date that is subject to the rule, inclusive, YYYY-MM or YYYY-MM-DD.
   *
   * Leave before it is left alone. Those days were never charged — the ledger
   * opens at zero on this date and Lark history older than Timo is mirrored
   * without being billed — so calling them unfunded would invent a debt the
   * ledger already forgave.
   */
  since?: string;
  /** Per-user accrual start, for someone who joined after `since`. */
  accrualStartFor?: Readonly<Record<string, string | undefined>>;
}

/**
 * userId -> date -> days of that date's leave a balance covered.
 *
 * Only days the balance did not cover in full appear. A date that is absent was
 * paid for outright, which is the common case and not worth a map entry.
 */
export type LeaveFundingDays = Map<string, Map<string, number>>;

export function resolveLeaveFunding(input: LeaveFundingInput): LeaveFundingDays {
  const creditsByUser = new Map<string, LeaveCredit[]>();
  for (const c of input.credits) {
    const list = creditsByUser.get(c.userId);
    if (list) list.push(c);
    else creditsByUser.set(c.userId, [c]);
  }

  const daysByUser = new Map<string, ChargeableLeaveDay[]>();
  for (const d of input.leaveDays) {
    const list = daysByUser.get(d.userId);
    if (list) list.push(d);
    else daysByUser.set(d.userId, [d]);
  }

  const out: LeaveFundingDays = new Map();

  for (const [userId, days] of daysByUser) {
    // The floor is whichever starts later: the workspace's ledger start, or
    // the day this person began accruing. Before either, nothing was charged.
    const floor = laterOf(input.since, input.accrualStartFor?.[userId]);
    const inScope = days
      .filter((d) => !floor || d.date >= floor)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (inScope.length === 0) continue;

    const credits = (creditsByUser.get(userId) ?? [])
      .filter((c) => !floor || c.effectiveOn >= floor)
      .sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : a.effectiveOn > b.effectiveOn ? 1 : 0));

    const short = new Map<string, number>();
    let budget = 0;
    let nextCredit = 0;

    for (const day of inScope) {
      // Everything credited on or before this date is available to it: an
      // accrual dated the 1st pays for leave taken on the 1st.
      for (let c = credits[nextCredit]; c && c.effectiveOn <= day.date; c = credits[nextCredit]) {
        budget = roundToHalfDay(budget + c.days);
        nextCredit += 1;
      }
      if (budget >= day.cost) {
        budget = roundToHalfDay(budget - day.cost);
        continue;
      }
      // Whatever is left pays for as much of the day as it reaches, and is
      // spent doing it. A balance driven negative by an adjustment buys
      // nothing, hence the floor at zero rather than a subtraction that would
      // hand back credit the person does not have.
      const funded = Math.max(0, roundToHalfDay(budget));
      short.set(day.date, funded);
      budget = roundToHalfDay(budget - funded);
    }

    if (short.size > 0) out.set(userId, short);
  }

  return out;
}

/**
 * The later of two optional YYYY-MM / YYYY-MM-DD bounds.
 *
 * Compared as strings, which is only sound because both are zero-padded ISO.
 * A bare month sorts before every day inside it, which is what we want: a
 * `since` of "2026-08" must admit "2026-08-01".
 */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

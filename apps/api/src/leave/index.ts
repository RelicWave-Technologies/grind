export { leaveDateRange, weekdayForDate } from './workingCalendar';
export { consumptionSourceKey } from './ledger';
export {
  loadWorkingCalendar,
  loadApprovedWfh,
  loadBalance,
  loadBalances,
  loadLedgerEntries,
  loadOrCreateLeavePolicy,
  toLeavePolicyDto,
  toIsoDate,
  fromIsoDate,
  accrualStartDate,
} from './repository';
export {
  ensureAccruals,
  toLeaveRequestDto,
  REQUEST_INCLUDE,
} from './service';
export { ingestLarkLeaveOnce, startLarkLeaveIngest } from './larkIngest';
export { startLarkWfhIngest } from './larkWfhIngest';
export { leaveDecidedInLark, setLeaveDecidedInLarkForTests } from './approvalGateway';

import { loadWorkingCalendar } from './repository';
import type { DayStatus } from '@grind/types';
import type { LeaveAccount } from './leaveFunding';

/**
 * The one call every timesheet consumer makes.
 *
 * Returns what `timesheetMatrixFromBuckets` needs to carry calendar
 * status on its cells. Wrapped in a helper so attendance, member reports,
 * the month report and MCP cannot drift into loading the calendar four slightly
 * different ways — the failure mode being a person who reads as on leave in
 * one screen and absent in another.
 */
export async function timesheetCalendarInputs(input: {
  workspaceId: string;
  tz: string;
  userIds: string[];
  from: string;
  to: string;
}): Promise<{
  dayStatusFor: (userId: string, date: string) => DayStatus | null;
  /** Days of that date's leave a balance covered, undefined when it covered all. */
  fundedDaysFor: (userId: string, date: string) => number | undefined;
  /** Opening, earned, paid and closing leave over [from, to]. */
  leaveAccountFor: (userId: string) => LeaveAccount | undefined;
  userIds: string[];
}> {
  const calendar = await loadWorkingCalendar(input);
  return {
    dayStatusFor: (userId, date) => calendar.dayStatus(userId, date),
    fundedDaysFor: (userId, date) => calendar.fundedDaysFor(userId, date),
    leaveAccountFor: (userId) => calendar.leaveAccountFor(userId),
    userIds: input.userIds,
  };
}

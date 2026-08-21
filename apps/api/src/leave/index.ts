export {
  WorkingCalendar,
  leaveDateRange,
  addIsoDays,
  weekdayForDate,
  type ShiftAssignmentInput,
  type HolidayInput,
  type ApprovedLeaveInput,
} from './workingCalendar';
export {
  projectBalance,
  accrualsDue,
  affordability,
  accrualSourceKey,
  consumptionSourceKey,
  reversalSourceKey,
  monthOf,
  type LeaveLedgerEntry,
  type LeaveBalance,
} from './ledger';
export {
  loadWorkingCalendar,
  loadBalance,
  loadBalances,
  loadLedgerEntries,
  loadOrCreateLeavePolicy,
  toLeavePolicyDto,
  toIsoDate,
  fromIsoDate,
} from './repository';
export {
  quoteLeave,
  submitLeaveRequest,
  decideLeaveRequest,
  cancelLeaveRequest,
  ensureAccruals,
  toLeaveRequestDto,
  REQUEST_INCLUDE,
} from './service';
export {
  ingestLarkLeaveOnce,
  startLarkLeaveIngest,
  stopLarkLeaveIngest,
  listLeaveInstanceCodes,
  fetchLeaveInstance,
  portionFor,
  type LarkLeaveInstance,
  type LeaveIngestResult,
} from './larkIngest';
export {
  decisionFromLarkStatus,
  leaveDecidedInLark,
  setLeaveDecidedInLarkForTests,
  type ExternalDecision,
} from './approvalGateway';

import { loadWorkingCalendar } from './repository';
import type { DayStatus } from '@grind/types';

/**
 * The one call every timesheet consumer makes.
 *
 * Returns the two arguments `buildTimesheetMatrix` needs to carry calendar
 * status on its cells. Wrapped in a helper so attendance, member reports,
 * payroll and MCP cannot drift into loading the calendar four slightly
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
  userIds: string[];
}> {
  const calendar = await loadWorkingCalendar(input);
  return {
    dayStatusFor: (userId, date) => calendar.dayStatus(userId, date),
    userIds: input.userIds,
  };
}

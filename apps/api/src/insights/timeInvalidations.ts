import { loadInvalidations } from '../time';
import type { TimeInvalidationInput } from './timesheets';

/**
 * Kept only for payroll (being removed), in its old input shape. New code
 * reads invalidations through `apps/api/src/time` with the rest of the time.
 */
export async function loadTimeInvalidationsForUsers(
  userIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<TimeInvalidationInput[]> {
  const rows = await loadInvalidations(userIds, rangeStart, rangeEnd);
  return rows.map((r) => ({ userId: r.userId, startedAt: r.start, endedAt: r.end }));
}

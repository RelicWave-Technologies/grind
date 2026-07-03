import { prisma } from '@grind/db';
import type { TimeInvalidationInput } from './invalidations';

export async function loadTimeInvalidationsForUsers(
  userIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<TimeInvalidationInput[]> {
  if (userIds.length === 0) return [];
  const rows = await prisma.timeInvalidation.findMany({
    where: {
      userId: { in: userIds },
      windowStart: { lt: rangeEnd },
      windowEnd: { gt: rangeStart },
    },
    select: { userId: true, windowStart: true, windowEnd: true },
    orderBy: [{ userId: 'asc' }, { windowStart: 'asc' }],
  });
  return rows.map((row) => ({
    userId: row.userId,
    startedAt: row.windowStart.getTime(),
    endedAt: row.windowEnd.getTime(),
  }));
}

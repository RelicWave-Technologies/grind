import { describe, expect, it } from 'vitest';
import { buildTesterOpsUsageCard } from './cards';

function findElement(card: Record<string, unknown>, tag: string): Record<string, unknown> | null {
  const seen: unknown[] = [card];
  while (seen.length) {
    const current = seen.pop();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if (record.tag === tag) return record;
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) seen.push(...value);
      else seen.push(value);
    }
  }
  return null;
}

describe('tester ops Lark cards', () => {
  it('keeps status cards on conservative Lark-safe elements', () => {
    const card = buildTesterOpsUsageCard({
      generatedAt: '2026-07-05T16:20:00.000Z',
      date: '2026-07-05',
      timezone: 'Asia/Kolkata',
      totals: { testers: 1, trackingNow: 1, silent: 0 },
      testers: [
        {
          userId: 'user_1',
          name: 'Anish Suman',
          avatarUrl: null,
          openId: 'ou_user_1',
          trackedMinutes: 42,
          screenshots: 3,
          agentState: 'RUNNING',
          agentLastSeenAt: '2026-07-05T16:19:00.000Z',
        },
      ],
    });

    expect(findElement(card, 'table')).toBeNull();
    expect(findElement(card, 'person_list')).toBeNull();
    expect(findElement(card, 'markdown')).not.toBeNull();
  });
});

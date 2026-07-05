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
  it('renders a Card 2.0 status view with profile images and useful labels', () => {
    const card = buildTesterOpsUsageCard({
      generatedAt: '2026-07-05T16:20:00.000Z',
      date: '2026-07-05',
      timezone: 'Asia/Kolkata',
      totals: { testers: 3, trackingNow: 1, silent: 1 },
      testers: [
        {
          userId: 'user_1',
          name: 'Silent Tester',
          avatarUrl: null,
          openId: 'ou_silent',
          trackedMinutes: 0,
          screenshots: 0,
          agentState: 'OFFLINE',
          agentLastSeenAt: null,
          isLiveNow: false,
        },
        {
          userId: 'user_2',
          name: 'Anish Suman',
          avatarUrl: null,
          openId: 'ou_active',
          trackedMinutes: 42,
          screenshots: 3,
          agentState: 'RUNNING',
          agentLastSeenAt: '2026-07-05T16:19:00.000Z',
          isLiveNow: true,
        },
        {
          userId: 'user_3',
          name: 'Progress Tester',
          avatarUrl: null,
          openId: 'ou_progress',
          trackedMinutes: 90,
          screenshots: 2,
          agentState: 'OFFLINE',
          agentLastSeenAt: '2026-07-05T15:10:00.000Z',
          isLiveNow: false,
        },
      ],
    });
    const serialized = JSON.stringify(card);
    const people = findElement(card, 'person_list');

    expect(card.schema).toBe('2.0');
    expect(findElement(card, 'table')).toBeNull();
    expect(people).toMatchObject({
      show_avatar: true,
      show_name: true,
      drop_invalid_user_id: true,
    });
    expect(findElement(card, 'markdown')).not.toBeNull();
    expect(serialized).toContain('Live now');
    expect(serialized).toContain('Not started today');
    expect(serialized).not.toContain('UNKNOWN');
    expect(serialized.indexOf('Progress Tester')).toBeLessThan(serialized.indexOf('Silent Tester'));
  });
});

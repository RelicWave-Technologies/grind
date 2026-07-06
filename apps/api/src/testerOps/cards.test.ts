import { describe, expect, it } from 'vitest';
import { buildTesterOpsIssueListCard, buildTesterOpsUsageCard } from './cards';

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
    const table = findElement(card, 'table');

    expect(card.schema).toBe('2.0');
    expect(table).toMatchObject({
      tag: 'table',
      element_id: 'tester_table',
      freeze_first_column: true,
      row_height: 'low',
    });
    expect(table?.page_size).toBe(3);
    expect(table?.rows).toHaveLength(3);
    expect(table?.columns).toEqual([
      expect.objectContaining({ name: 'tester', display_name: 'Tester' }),
      expect.objectContaining({ name: 'state', display_name: 'State', data_type: 'options' }),
      expect.objectContaining({ name: 'work', display_name: 'Today' }),
      expect.objectContaining({ name: 'seen', display_name: 'Seen' }),
    ]);
    expect(people).toMatchObject({
      show_avatar: true,
      show_name: true,
      drop_invalid_user_id: true,
    });
    expect(findElement(card, 'markdown')).not.toBeNull();
    expect(serialized).toContain('"text":"Live","color":"green"');
    expect(serialized).toContain('"text":"Worked","color":"blue"');
    expect(serialized).toContain('"text":"No time","color":"orange"');
    expect(serialized).toContain('42m · 3 shots');
    expect(serialized).toContain('Needs check-in');
    expect(serialized).toContain('<at id=ou_silent></at>');
    expect(serialized).toContain('Please reply with why Timo is not running today');
    expect(serialized).not.toContain('| seen');
    expect(serialized).not.toContain('UNKNOWN');
    expect(serialized.indexOf('Progress Tester')).toBeLessThan(serialized.indexOf('Silent Tester'));
  });
});

describe('tester ops issue list card', () => {
  it('renders active issues with severity, reporter mentions, and counts', () => {
    const card = buildTesterOpsIssueListCard({
      items: [
        { status: 'OPEN', severity: 'HIGH', category: 'Upload', summary: 'Screenshots stop uploading', reporterOpenId: 'ou_r1', createdAt: '2026-07-06T05:00:00.000Z' },
        { status: 'CANDIDATE', severity: 'LOW', category: null, summary: 'Widget corner radius off', reporterOpenId: 'ou_r2', createdAt: '2026-07-06T04:00:00.000Z' },
      ],
      total: 2,
      openCount: 1,
      candidateCount: 1,
      severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1 },
      generatedAt: '2026-07-06T05:30:00.000Z',
      timezone: 'Asia/Kolkata',
    });
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe('2.0');
    expect(serialized).toContain('2 active issues');
    expect(serialized).toContain('Screenshots stop uploading');
    expect(serialized).toContain('<at id=ou_r1></at>');
    expect(serialized).toContain('needs review');
    expect(serialized).toContain('"content":"1 open"');
  });

  it('renders a clean empty state when nothing is logged', () => {
    const card = buildTesterOpsIssueListCard({
      items: [],
      total: 0,
      openCount: 0,
      candidateCount: 0,
      severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      generatedAt: '2026-07-06T05:30:00.000Z',
      timezone: 'Asia/Kolkata',
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('All clear');
    expect(serialized).toContain('"content":"0 open"');
  });
});

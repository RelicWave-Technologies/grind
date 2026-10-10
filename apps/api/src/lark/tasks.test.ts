import { describe, it, expect } from 'vitest';
import { buildCreateTaskPayload, mapTasks, toEpochMs, type RawLarkTask } from './tasks';

describe('mapTasks', () => {
  it('returns [] for undefined or empty input', () => {
    expect(mapTasks(undefined)).toEqual([]);
    expect(mapTasks([])).toEqual([]);
  });

  it('maps guid + summary + url and derives completed from completed_at', () => {
    const raw: RawLarkTask[] = [
      { guid: 'g1', summary: 'Write tests', completed_at: '0', url: 'https://lark/g1' },
      { guid: 'g2', summary: 'Ship M9', completed_at: '1700000000000' },
    ];
    expect(mapTasks(raw)).toEqual([
      { guid: 'g1', summary: 'Write tests', completed: false, url: 'https://lark/g1', due: null, createdAt: null, creatorId: null, creatorName: null, loggedMs: 0, loggedTodayMs: 0, loggedTotalMs: 0 },
      { guid: 'g2', summary: 'Ship M9', completed: true, url: undefined, due: null, createdAt: null, creatorId: null, creatorName: null, loggedMs: 0, loggedTodayMs: 0, loggedTotalMs: 0 },
    ]);
  });

  it('maps a due timestamp (seconds) to epoch ms', () => {
    const [t] = mapTasks([{ guid: 'g', summary: 's', due: { timestamp: '1623124318' } }]);
    expect(t!.due).toBe(1623124318 * 1000);
  });

  it('maps creator id + created_at', () => {
    const [t] = mapTasks([{ guid: 'g', summary: 's', created_at: '1700000000000', creator: { id: 'ou_x' } }]);
    expect(t!.creatorId).toBe('ou_x');
    expect(t!.createdAt).toBe(1700000000000);
    expect(t!.creatorName).toBeNull();
  });

  it('treats missing/zero completed_at as not completed', () => {
    expect(mapTasks([{ guid: 'g', summary: 's' }])[0]!.completed).toBe(false);
    expect(mapTasks([{ guid: 'g', summary: 's', completed_at: '0' }])[0]!.completed).toBe(false);
  });

  it('drops items without a guid (cannot attribute time to them)', () => {
    const raw: RawLarkTask[] = [{ summary: 'no guid' }, { guid: 'g', summary: 'ok' }];
    expect(mapTasks(raw).map((t) => t.guid)).toEqual(['g']);
  });

  it('falls back to a placeholder summary when missing', () => {
    expect(mapTasks([{ guid: 'g' }])[0]!.summary).toBe('(untitled task)');
  });
});

describe('toEpochMs', () => {
  it('returns null for absent / zero', () => {
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs('0')).toBeNull();
    expect(toEpochMs('')).toBeNull();
  });
  it('treats 10-digit values as seconds and 13-digit as ms', () => {
    expect(toEpochMs('1623124318')).toBe(1623124318000);
    expect(toEpochMs('1623124318000')).toBe(1623124318000);
  });
});

describe('buildCreateTaskPayload', () => {
  it('sends due timestamps in epoch milliseconds for Lark Task v2 create', () => {
    expect(buildCreateTaskPayload({ summary: 'Ship', due: 1_762_944_300_000 })).toMatchObject({
      summary: 'Ship',
      due: { timestamp: '1762944300000', is_all_day: false },
    });
  });

  it('adds the token owner as a user assignee when an open_id is available', () => {
    expect(buildCreateTaskPayload({ summary: 'Ship', assigneeOpenId: 'ou_abc' })).toMatchObject({
      members: [{ id: 'ou_abc', type: 'user', role: 'assignee' }],
    });
  });
});

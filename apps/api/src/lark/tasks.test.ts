import { describe, it, expect } from 'vitest';
import { mapTasks, type RawLarkTask } from './tasks';

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
      { guid: 'g1', summary: 'Write tests', completed: false, url: 'https://lark/g1' },
      { guid: 'g2', summary: 'Ship M9', completed: true, url: undefined },
    ]);
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

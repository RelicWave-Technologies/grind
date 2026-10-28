import { describe, expect, it } from 'vitest';
import { sortRows } from './tableSort';

describe('sortRows', () => {
  const rows = [{ n: 'b', h: 5 }, { n: 'a', h: null }, { n: 'c', h: 9 }, { n: 'd', h: 5 }];
  it('sorts numbers both ways, keeping ties in their order', () => {
    expect(sortRows(rows, (r) => r.h, 'desc').map((r) => r.n)).toEqual(['c', 'b', 'd', 'a']);
    expect(sortRows(rows, (r) => r.h, 'asc').map((r) => r.n)).toEqual(['b', 'd', 'c', 'a']);
  });
  it('keeps blanks last either way', () => {
    expect(sortRows(rows, (r) => r.h, 'asc').at(-1)!.n).toBe('a');
  });
  it('sorts text naturally, ignoring case', () => {
    expect(sortRows([{ s: 'item 10' }, { s: 'Item 2' }], (r) => r.s, 'asc').map((r) => r.s)).toEqual(['Item 2', 'item 10']);
  });
});

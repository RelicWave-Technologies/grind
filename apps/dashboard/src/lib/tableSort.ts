import { useMemo, useState } from 'react';

/**
 * Click-to-sort for a table — the logic half; the header look is the kit's
 * `<Th sortable sortDir>`. Pair it with `useTableFilter`: filter first, then
 * sort what is left.
 *
 * A first click sorts largest first (most hours, latest time, Z→A), a second
 * flips it, a third goes back to the table's own order. Blanks always sink to
 * the bottom, whichever way it runs, so "—" never wins a column.
 */

export type SortValue = number | string | null | undefined;
export type SortDir = 'asc' | 'desc';
export type SortKeys<T> = Record<string, (row: T) => SortValue>;

const isBlank = (v: SortValue) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));

export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const blankA = isBlank(a.v);
      const blankB = isBlank(b.v);
      if (blankA || blankB) return blankA === blankB ? a.index - b.index : blankA ? 1 : -1;
      const cmp = typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' });
      return cmp !== 0 ? sign * cmp : a.index - b.index;
    })
    .map((x) => x.row);
}

export function useTableSort<T, K extends SortKeys<T>>(rows: readonly T[], keys: K) {
  const [sort, setSort] = useState<{ key: keyof K & string; dir: SortDir } | null>(null);
  const sorted = useMemo(
    () => (sort ? sortRows(rows, keys[sort.key]!, sort.dir) : [...rows]),
    // `keys` is a fresh object each render; what it sorts by changes with `sort`.
    [rows, sort],
  );
  /** Props for the column's `<Th>`. */
  const th = (key: keyof K & string) => ({
    sortable: true as const,
    sortDir: sort?.key === key ? sort.dir : undefined,
    onClick: () =>
      setSort((cur) =>
        cur?.key !== key ? { key, dir: 'desc' } : cur.dir === 'desc' ? { key, dir: 'asc' } : null),
    title: 'Sort',
  });
  return { rows: sorted, th };
}

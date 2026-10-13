/**
 * Text matching — the ONE implementation behind every search in the kit: the
 * table filter (src/lib/tableFilter.ts) and the Combobox's type-to-filter both
 * call it, so "Zoë" finds "zoe" in a table and in a picker alike.
 */

/** Case- and accent-insensitive form used for matching. */
export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * True when every whitespace-separated term of `query` appears in at least one
 * field — so "anish eng" finds Anish in Engineering.
 */
export function matchesQuery(fields: ReadonlyArray<string | number | null | undefined>, query: string): boolean {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields
    .filter((f): f is string | number => f !== null && f !== undefined && f !== '')
    .map((f) => normalizeText(String(f)));
  return terms.every((term) => haystack.some((field) => field.includes(term)));
}

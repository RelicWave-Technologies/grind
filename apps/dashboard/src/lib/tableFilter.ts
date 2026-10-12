import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { FilterOption, TableFilterControls } from '../ui';

/**
 * Table filtering — the ONE implementation behind every filter bar.
 *
 * A page declares which fields free text searches and which facets (role,
 * team, status, …) narrow the rows; this module does the matching, derives
 * facet options from the data, and keeps the state in the URL so a filtered
 * view survives a reload and can be linked. Rendering lives in the kit
 * (`FilterBar`, `NoMatches`); pages never hand-roll filter logic.
 *
 *   const filter = useTableFilter(users, {
 *     text: (u) => [u.name, u.email],
 *     facets: { role: { label: 'Roles', value: (u) => u.role } },
 *   });
 *   <FilterBar filter={filter} placeholder="Search people" />
 *   {filter.rows.length === 0 ? <NoMatches onClear={filter.clear} /> : <Table>…</Table>}
 */

export interface FacetSpec<T> {
  /** Plural noun for the control: the select reads "All <label>". */
  label: string;
  /** The row's value(s) for this facet. Empty/nullish never matches a choice. */
  value: (row: T) => string | ReadonlyArray<string> | null | undefined;
  /** Fixed choices, in display order. Omitted → derived from the rows. */
  options?: ReadonlyArray<FilterOption>;
  /** Label for a derived value (e.g. 'darwin' → 'macOS'). */
  optionLabel?: (value: string) => string;
}

export interface FilterSpec<T, K extends string = string> {
  /** Fields the free-text search looks through. */
  text?: (row: T) => ReadonlyArray<string | number | null | undefined>;
  facets?: Readonly<Record<K, FacetSpec<T>>>;
}

export interface FilterState<K extends string = string> {
  query: string;
  /** Facet key → chosen value. Absent or '' means "all". */
  facets: Partial<Record<K, string>>;
}

export interface UseTableFilterOptions<K extends string> {
  /**
   * Prefix for this table's URL params (`q`, and one per facet key). Give
   * each table on a page its own prefix; '' (default) for a page's main table.
   */
  urlPrefix?: string;
  /** Keep the filter in the URL. Off for tables inside modals and drawers. */
  persist?: boolean;
  /**
   * Facet defaults (e.g. an approval queue that opens on Pending). The URL
   * overrides them per facet; a value equal to its default stays out of the URL.
   * Clear still means "show everything".
   */
  initial?: Partial<Record<K, string>>;
}

export interface TableFilter<T, K extends string = string> extends TableFilterControls {
  /** The rows that pass every filter, in their original order. */
  rows: T[];
  /** Current value of one facet ('' = all). */
  value: (key: K) => string;
  /** Set one facet — for pages that render that facet with their own control. */
  setValue: (key: K, value: string) => void;
}

const URL_WRITE_DELAY_MS = 250;

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

function facetValues<T>(facet: FacetSpec<T>, row: T): string[] {
  const raw = facet.value(row);
  if (raw === null || raw === undefined) return [];
  return (typeof raw === 'string' ? [raw] : [...raw]).filter((v) => v !== '');
}

/** Rows passing the text query AND every chosen facet. Order is preserved. */
export function applyTableFilter<T, K extends string>(
  rows: ReadonlyArray<T>,
  spec: FilterSpec<T, K>,
  state: FilterState<K>,
): T[] {
  const chosen = (Object.keys(spec.facets ?? {}) as K[])
    .map((key) => [spec.facets![key], state.facets[key] ?? ''] as const)
    .filter(([, value]) => value !== '');
  const query = state.query.trim();
  return rows.filter((row) => {
    if (query && spec.text && !matchesQuery(spec.text(row), query)) return false;
    return chosen.every(([facet, value]) => facetValues(facet, row).includes(value));
  });
}

/** A facet's choices: the fixed list, or every distinct value in the rows. */
export function facetOptions<T>(rows: ReadonlyArray<T>, facet: FacetSpec<T>): FilterOption[] {
  if (facet.options) return [...facet.options];
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const value of facetValues(facet, row)) {
      if (!seen.has(value)) seen.set(value, facet.optionLabel ? facet.optionLabel(value) : value);
    }
  }
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * URL spelling of "all" for a facet whose default is NOT all (e.g. an approval
 * queue that opens on Pending): without it, choosing All and reloading would
 * bring the default back.
 */
const ALL_PARAM = 'all';

/**
 * Read this table's filter from parsed URL search params. A facet present in
 * the URL is returned even when it says "all" (as ''), so it overrides a default.
 */
export function readFilterParams<K extends string>(
  search: Record<string, unknown>,
  prefix: string,
  keys: ReadonlyArray<K>,
): FilterState<K> {
  const read = (name: string): string | undefined => {
    const raw = search[`${prefix}${name}`];
    return raw === undefined || raw === null || raw === '' ? undefined : String(raw);
  };
  const facets: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = read(key);
    if (value !== undefined) facets[key] = value === ALL_PARAM ? '' : value;
  }
  return { query: read('q') ?? '', facets };
}

/**
 * `search` with this table's params replaced by `state`. Values equal to the
 * default are dropped, so an untouched table leaves the URL alone.
 */
export function writeFilterParams<K extends string>(
  search: Record<string, unknown>,
  prefix: string,
  keys: ReadonlyArray<K>,
  state: FilterState<K>,
  defaults: Partial<Record<K, string>> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...search };
  const put = (name: string, value: string | undefined) => {
    if (value) next[`${prefix}${name}`] = value;
    else delete next[`${prefix}${name}`];
  };
  put('q', state.query.trim() ? state.query : undefined);
  for (const key of keys) {
    const value = state.facets[key] ?? '';
    const fallback = defaults[key] ?? '';
    put(key, value === fallback ? undefined : value === '' ? ALL_PARAM : value);
  }
  return next;
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (String(a[key] ?? '') !== String(b[key] ?? '')) return false;
  return true;
}

/**
 * Filter `rows` by a text query and facets, with state mirrored to the URL.
 * Returns the filtered rows plus everything `FilterBar` needs to render.
 */
export function useTableFilter<T, K extends string = never>(
  rows: ReadonlyArray<T>,
  spec: FilterSpec<T, K>,
  options: UseTableFilterOptions<K> = {},
): TableFilter<T, K> {
  const { urlPrefix = '', persist = true, initial } = options;
  const router = useRouter();
  const keys = Object.keys(spec.facets ?? {}) as K[];

  const [state, setState] = useState<FilterState<K>>(() => {
    const fromUrl = persist
      ? readFilterParams(router.state.location.search as Record<string, unknown>, urlPrefix, keys)
      : { query: '', facets: {} };
    // Per facet: the URL wins, otherwise the page's default.
    return { query: fromUrl.query, facets: { ...initial, ...fromUrl.facets } };
  });

  // URL is persistence, not the source of truth: typing stays instant, and the
  // address bar catches up once the user pauses.
  const stateKey = JSON.stringify(state);
  useEffect(() => {
    if (!persist) return;
    const timer = window.setTimeout(() => {
      const current = router.state.location.search as Record<string, unknown>;
      const next = writeFilterParams(current, urlPrefix, keys, state, initial);
      if (sameParams(current, next)) return;
      // Same page, new query string. The search type is the union of every
      // route's params; this only rewrites its own keys, hence the cast.
      void router.navigate({
        to: '.',
        search: (() => next) as never,
        replace: true,
        resetScroll: false,
      });
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `state` changes exactly when stateKey does; keys/defaults are fixed per table.
  }, [stateKey, persist, urlPrefix]);

  const filtered = applyTableFilter(rows, spec, state);
  const value = (key: K): string => state.facets[key] ?? '';
  const setValue = (key: K, next: string) =>
    setState((s) => ({ ...s, facets: { ...s.facets, [key]: next } }));
  const active = state.query.trim() !== '' || keys.some((key) => value(key) !== '');

  return {
    rows: filtered,
    query: state.query,
    setQuery: (query) => setState((s) => ({ ...s, query })),
    facets: keys.map((key) => {
      const facet = spec.facets![key];
      const opts = facetOptions(rows, facet);
      const current = value(key);
      // A value from an old link that no longer exists still shows, so the
      // user can see why the table is empty and clear it.
      if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
      return {
        key,
        label: facet.label,
        value: current,
        options: opts,
        onChange: (next: string) => setValue(key, next),
      };
    }),
    value,
    setValue,
    active,
    clear: () => setState({ query: '', facets: {} }),
    count: filtered.length,
    total: rows.length,
  };
}

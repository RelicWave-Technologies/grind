import type { ReactNode } from 'react';
import { SearchX } from 'lucide-react';
import { cx } from './util';
import { Button } from './Button';
import { Combobox } from './Combobox';
import { EmptyState } from './Feedback';
import { SearchInput } from './SearchInput';

/* §5.12b Filtering — the table-top filter row, its search box, and the
   "no matches" state. The matching itself lives in one hook
   (src/lib/tableFilter.ts → useTableFilter); these components only render
   the state it hands them, so every filtered table looks and behaves alike. */

export interface FilterOption {
  value: string;
  label: string;
}

/** One facet as the bar renders it: a Combobox with an "All …" choice. */
export interface FilterFacetControl {
  key: string;
  /** Plural noun — the empty choice reads "All <label>". */
  label: string;
  value: string;
  options: ReadonlyArray<FilterOption>;
  onChange: (value: string) => void;
}

/** What a filter bar needs — exactly what useTableFilter returns. */
export interface TableFilterControls {
  query: string;
  setQuery: (query: string) => void;
  facets: ReadonlyArray<FilterFacetControl>;
  active: boolean;
  clear: () => void;
  count: number;
  total: number;
}

export interface FilterBarProps {
  filter: TableFilterControls;
  placeholder?: string;
  /** Row noun for the count, e.g. { one: 'person', other: 'people' }. */
  noun?: { one: string; other: string };
  /** Facets the page renders with its own control (e.g. status Tabs). */
  hideFacets?: ReadonlyArray<string>;
  /** Extra controls after the facets (a Segmented, a toggle). */
  children?: ReactNode;
  /** Outside a flush Card (a drawer section): no padding, no rule under it. */
  plain?: boolean;
  className?: string;
}

/**
 * The filter row that sits on top of a table, inside its flush Card: search,
 * one Combobox per facet, then the live result count and Clear. A facet with a
 * single choice is hidden — there is nothing to pick between. Every facet is
 * the same control; a long one (People) leads its list with a search box.
 */
export function FilterBar({ filter, placeholder, noun, hideFacets, children, plain, className }: FilterBarProps) {
  const facets = filter.facets.filter(
    (f) => !hideFacets?.includes(f.key) && (f.options.length > 1 || f.value !== ''),
  );
  const unit = noun ? ` ${filter.total === 1 && !filter.active ? noun.one : noun.other}` : '';
  return (
    <div className={cx('ui-filter-bar', plain && 'ui-filter-bar--plain', className)} role="search">
      <div className="ui-filter-bar__controls">
        <SearchInput value={filter.query} onChange={filter.setQuery} placeholder={placeholder} />
        {facets.map((f) => (
          <Combobox
            key={f.key}
            className="ui-filter-bar__select"
            aria-label={`Filter by ${f.label.toLowerCase()}`}
            emptyLabel={`All ${f.label.toLowerCase()}`}
            searchPlaceholder={`Search ${f.label.toLowerCase()}`}
            value={f.value}
            options={f.options}
            onChange={f.onChange}
          />
        ))}
        {children}
      </div>
      <div className="ui-filter-bar__meta">
        <span className="ui-filter-bar__count ui-mono ui-t-small" aria-live="polite">
          {filter.active ? `${filter.count} of ${filter.total}` : filter.total}
          {unit}
        </span>
        {filter.active && (
          <Button variant="ghost" size="sm" onClick={filter.clear}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

export interface NoMatchesProps {
  onClear: () => void;
  description?: ReactNode;
  /** A nearer way out than clearing everything (e.g. "Show all statuses"), before Clear. */
  action?: ReactNode;
  className?: string;
}

/** The empty state for a filter that matched nothing — always offers the way out. */
export function NoMatches({ onClear, description = 'Nothing matches the current search and filters.', action, className }: NoMatchesProps) {
  return (
    <EmptyState
      className={className}
      icon={<SearchX size={22} strokeWidth={1.6} />}
      title="No matches"
      description={description}
      action={
        <>
          {action}
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        </>
      }
    />
  );
}

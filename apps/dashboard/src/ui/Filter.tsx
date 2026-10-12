import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Search, SearchX, X } from 'lucide-react';
import { cx } from './util';
import { Button, IconButton } from './Button';
import { Select } from './Field';
import { EmptyState } from './Feedback';

/* §5.12b Filtering — the table-top filter row, its search box, and the
   "no matches" state. The matching itself lives in one hook
   (src/lib/tableFilter.ts → useTableFilter); these components only render
   the state it hands them, so every filtered table looks and behaves alike. */

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (value: string) => void;
  /** Span the column (pickers, drawers) instead of the toolbar width. */
  block?: boolean;
}

/** A search field: leading glyph, Esc or the × clears it. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, block, className, placeholder = 'Search', onKeyDown, ...rest },
  ref,
) {
  return (
    <div className={cx('ui-search', block && 'ui-search--block', className)}>
      <span className="ui-search__icon" aria-hidden>
        <Search size={14} strokeWidth={1.9} />
      </span>
      <input
        ref={ref}
        type="search"
        className="ui-control ui-search__input"
        value={value}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
          onKeyDown?.(e);
        }}
        {...rest}
      />
      {value && (
        <IconButton
          className="ui-search__clear"
          size="sm"
          variant="ghost"
          icon={<X size={14} strokeWidth={1.9} />}
          aria-label="Clear search"
          onClick={() => onChange('')}
        />
      )}
    </div>
  );
});

export interface FilterOption {
  value: string;
  label: string;
}

/** One facet as the bar renders it: a Select with an "All …" choice. */
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
  className?: string;
}

/**
 * The filter row that sits on top of a table, inside its flush Card: search,
 * one Select per facet, then the live result count and Clear. A facet with a
 * single choice is hidden — there is nothing to pick between.
 */
export function FilterBar({ filter, placeholder, noun, hideFacets, children, className }: FilterBarProps) {
  const facets = filter.facets.filter(
    (f) => !hideFacets?.includes(f.key) && (f.options.length > 1 || f.value !== ''),
  );
  const unit = noun ? ` ${filter.total === 1 && !filter.active ? noun.one : noun.other}` : '';
  return (
    <div className={cx('ui-filter-bar', className)} role="search">
      <div className="ui-filter-bar__controls">
        <SearchInput value={filter.query} onChange={filter.setQuery} placeholder={placeholder} />
        {facets.map((f) => (
          <Select
            key={f.key}
            className="ui-filter-bar__select"
            aria-label={`Filter by ${f.label.toLowerCase()}`}
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
          >
            <option value="">{`All ${f.label.toLowerCase()}`}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
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
  className?: string;
}

/** The empty state for a filter that matched nothing — always offers the way out. */
export function NoMatches({ onClear, description = 'Nothing matches the current search and filters.', className }: NoMatchesProps) {
  return (
    <EmptyState
      className={className}
      icon={<SearchX size={22} strokeWidth={1.6} />}
      title="No matches"
      description={description}
      action={
        <Button variant="secondary" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}

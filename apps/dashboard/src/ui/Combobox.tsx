import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cx } from './util';
import { matchesQuery } from './match';
import { usePopover } from './popover';
import { SearchInput } from './SearchInput';

/* §5.9b Combobox — a select you can search. A button that names the current
   choice; it opens a popover with a search box (once the list is long enough to
   need one) over the option list, the chosen option ticked. Keyboard: ↑/↓ move,
   Enter picks, Esc clears the search and then closes, and typing on the closed
   button opens it already filtering. FilterBar renders every facet with it, so a
   90-person "People" list is as quick to use as a 3-choice "Statuses" one. */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra text the search also matches (an email, a team), never shown. */
  keywords?: ReadonlyArray<string | null | undefined>;
}

/** Past this many options the popover leads with a search box. */
export const COMBOBOX_SEARCH_MIN = 8;

export interface ComboboxProps {
  value: string;
  options: ReadonlyArray<ComboboxOption>;
  onChange: (value: string) => void;
  /** Accessible name — the trigger shows only the current choice. */
  'aria-label': string;
  /** A '' choice pinned first (e.g. "All people"); omit when a value is required. */
  emptyLabel?: string;
  /** Trigger text while nothing is chosen and there is no `emptyLabel`. */
  placeholder?: string;
  searchPlaceholder?: string;
  /** Force the search box on or off; default: more than COMBOBOX_SEARCH_MIN options. */
  searchable?: boolean;
  disabled?: boolean;
  /** Span the column (forms, drawers) instead of sizing to the label. */
  block?: boolean;
  className?: string;
}

/**
 * What the open list shows for `query`: the pinned empty choice (when there is
 * one), then every option whose label or keywords match. Matching is the kit's
 * own accent- and case-insensitive `matchesQuery`.
 */
export function comboboxItems(
  options: ReadonlyArray<ComboboxOption>,
  query: string,
  emptyLabel?: string,
): ComboboxOption[] {
  const matches = options.filter((o) => matchesQuery([o.label, ...(o.keywords ?? [])], query));
  return emptyLabel === undefined ? matches : [{ value: '', label: emptyLabel }, ...matches];
}

/**
 * The row to highlight when the list opens or the query changes: the first
 * match while searching (Enter then picks it), otherwise the current choice.
 */
export function initialActiveIndex(items: ReadonlyArray<ComboboxOption>, value: string, query: string): number {
  if (query.trim()) {
    const first = items.findIndex((o) => o.value !== '');
    return first === -1 ? 0 : first;
  }
  return Math.max(0, items.findIndex((o) => o.value === value));
}

/** ↑/↓/Home/End over `count` rows, clamped at the ends. Null for any other key. */
export function moveActiveIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return Math.min(count - 1, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export function Combobox({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
  emptyLabel,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search',
  searchable,
  disabled,
  block,
  className,
}: ComboboxProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const withSearch = searchable ?? options.length > COMBOBOX_SEARCH_MIN;
  const pop = usePopover({
    estimatedHeight: 340,
    onOpen: () => (withSearch ? searchRef.current : listRef.current)?.focus(),
  });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const items = comboboxItems(options, query, emptyLabel);
  const current = options.find((o) => o.value === value);
  const triggerLabel = current?.label ?? (value === '' && emptyLabel !== undefined ? emptyLabel : value || placeholder);

  /** Set the search and move the highlight with it (see initialActiveIndex). */
  function search(next: string) {
    setQuery(next);
    setActive(initialActiveIndex(comboboxItems(options, next, emptyLabel), value, next));
  }

  /** Open on a fresh search — optionally seeded by the key that opened it. */
  function open(seed = '') {
    search(seed);
    pop.setOpen(true);
  }

  // Keep the highlighted row in view as the keyboard walks the list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function pick(option: ComboboxOption | undefined) {
    if (!option) return;
    onChange(option.value);
    pop.setOpen(false);
    (pop.triggerRef.current as HTMLElement | null)?.focus();
  }

  function onListKey(e: React.KeyboardEvent) {
    const next = moveActiveIndex(active, e.key, items.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape' && e.defaultPrevented) {
      // SearchInput consumed this Esc to clear the query; keep the popover
      // open so the next Esc is the one that closes it.
      e.stopPropagation();
    } else if (e.key === 'Tab') {
      pop.setOpen(false);
    }
  }

  const triggerWidth = (pop.triggerRef.current as HTMLElement | null)?.offsetWidth;
  const activeId = items[active] ? `${listId}-${active}` : undefined;

  return (
    <>
      <button
        ref={pop.triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        role="combobox"
        className={cx('ui-control', 'ui-select', 'ui-combobox', block && 'ui-combobox--block', className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-controls={pop.open ? listId : undefined}
        disabled={disabled}
        title={triggerLabel}
        onClick={() => (pop.open ? pop.setOpen(false) : open())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open();
          } else if (withSearch && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Type-to-filter: the first key opens the list already searching.
            e.preventDefault();
            open(e.key);
          }
        }}
      >
        <span className={cx('ui-combobox__label', !current && value === '' && emptyLabel === undefined && 'is-placeholder')}>
          {triggerLabel}
        </span>
      </button>
      {pop.open &&
        createPortal(
          <div
            ref={pop.popoverRef}
            className="ui-popover ui-combobox__pop"
            data-flip={pop.flip}
            style={{ ...pop.popoverStyle, minWidth: triggerWidth }}
          >
            {withSearch && (
              <SearchInput
                ref={searchRef}
                block
                className="ui-combobox__search"
                value={query}
                onChange={search}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                onKeyDown={onListKey}
              />
            )}
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="ui-combobox__list"
              tabIndex={withSearch ? undefined : -1}
              aria-activedescendant={withSearch ? undefined : activeId}
              onKeyDown={withSearch ? undefined : onListKey}
            >
              {items.map((option, index) => {
                const selected = option.value === value;
                return (
                  <div
                    key={option.value || '__all__'}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    className={cx('ui-combobox__option', index === active && 'is-active', option.value === '' && 'is-all')}
                    onMouseEnter={() => setActive(index)}
                    // Keep focus in the search box; the click picks.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(option)}
                  >
                    <span className="ui-combobox__option-label">{option.label}</span>
                    {selected && <Check className="ui-combobox__tick" size={14} strokeWidth={2.2} aria-hidden />}
                  </div>
                );
              })}
              {items.every((o) => o.value === '') && (
                <div className="ui-combobox__empty ui-t-small" role="presentation">
                  No matches
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

import { forwardRef } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from './util';
import { IconButton } from './Button';

/* §5.12b SearchInput — the one search field: table filter bars, pickers, and
   the Combobox's popover all use it. */

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

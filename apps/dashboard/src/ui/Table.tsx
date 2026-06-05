import type { ReactNode } from 'react';
import { cx } from './util';
import type { Rail } from './util';

/* §5.5 Table — the one tabular surface. Host in <Card variant="flush">.
   Header labels are eyebrows; numbers are mono + tabular, right-aligned.
   Identity/status via a 3px inset left-rail on the first cell — never a full
   row tint beyond the selected wash. */
export type TableDensity = 'comfortable' | 'compact';
export type Align = 'left' | 'right' | 'center';

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  density?: TableDensity;
  /** Make the header sticky on vertical scroll. */
  stickyHead?: boolean;
  /** Make the first column sticky on horizontal scroll. */
  stickyCol?: boolean;
  children: ReactNode;
}

export function Table({
  density = 'comfortable',
  stickyHead,
  stickyCol,
  className,
  children,
  ...rest
}: TableProps) {
  return (
    <table
      className={cx(
        'ui-table',
        density === 'compact' && 'ui-table--compact',
        stickyHead && 'ui-table--sticky-head',
        stickyCol && 'ui-table--sticky-col',
        className,
      )}
      {...rest}
    >
      {children}
    </table>
  );
}

export function THead({ children, className, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cx('ui-table__head', className)} {...rest}>
      {children}
    </thead>
  );
}

export function Tbody({ children, className, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={className} {...rest}>
      {children}
    </tbody>
  );
}

export interface ThProps extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: Align;
  sortable?: boolean;
  /** Active sort direction; when set, the header reads as the sorted column. */
  sortDir?: 'asc' | 'desc';
  children?: ReactNode;
}

export function Th({ align = 'left', sortable, sortDir, className, children, onClick, ...rest }: ThProps) {
  const sorted = sortDir != null;
  return (
    <th
      className={cx(
        'ui-th',
        align === 'right' && 'ui-th--right',
        align === 'center' && 'ui-th--center',
        sortable && 'ui-th--sortable',
        sorted && 'is-sorted',
        className,
      )}
      aria-sort={sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={onClick}
      {...rest}
    >
      {sortable ? (
        <span className="ui-th__sort">
          {align === 'right' && <span className="ui-th__caret" aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>}
          {children}
          {align !== 'right' && <span className="ui-th__caret" aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>}
        </span>
      ) : (
        children
      )}
    </th>
  );
}

export interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  rail?: Rail;
  children?: ReactNode;
}

export function Tr({ selected, rail, className, onClick, children, ...rest }: TrProps) {
  const clickable = onClick != null;
  return (
    <tr
      className={cx(
        'ui-table__row',
        selected && 'is-selected',
        clickable && 'is-clickable',
        rail && `ui-table__row--rail-${rail}`,
        className,
      )}
      onClick={onClick}
      aria-selected={selected || undefined}
      {...rest}
    >
      {children}
    </tr>
  );
}

export interface TdProps extends Omit<React.TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: Align;
  /** Render as a mono, right-aligned numeric cell. */
  mono?: boolean;
  children?: ReactNode;
}

export function Td({ align, mono, className, children, ...rest }: TdProps) {
  // `mono` implies right alignment unless an explicit align overrides it.
  const a = align ?? (mono ? 'right' : 'left');
  return (
    <td
      className={cx(
        'ui-td',
        mono ? 'ui-td--num' : a === 'right' && 'ui-td--right',
        a === 'center' && 'ui-td--center',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

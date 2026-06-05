import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './util';
import type { Rail } from './util';

/* §5.6 List + ListRow — a lightweight row stack, lighter than a Table.
   Feeds, members, settings groups, Approvals/Teams/Shifts cards. */
export interface ListProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function List({ children, className, ...rest }: ListProps) {
  return (
    <div className={cx('ui-list', className)} role="list" {...rest}>
      {children}
    </div>
  );
}

export interface ListRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading slot — an Avatar or icon. */
  leading?: ReactNode;
  /** Right-aligned mono value (durations, counts). */
  meta?: ReactNode;
  /** Trailing slot — a Tag, Button, or chevron. */
  trailing?: ReactNode;
  rail?: Rail;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export function ListRow({
  title,
  subtitle,
  leading,
  meta,
  trailing,
  rail,
  onClick,
  className,
  ...rest
}: ListRowProps) {
  const clickable = onClick != null;
  const onKeyDown = clickable
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      }
    : undefined;
  return (
    <div
      className={cx(
        'ui-list-row',
        clickable && 'is-clickable',
        rail && `ui-list-row--rail-${rail}`,
        className,
      )}
      role={clickable ? 'button' : 'listitem'}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {leading != null && <div className="ui-list-row__leading">{leading}</div>}
      <div className="ui-list-row__main">
        <span className="ui-list-row__title ui-t-strong">{title}</span>
        {subtitle != null && <span className="ui-list-row__sub ui-t-small">{subtitle}</span>}
      </div>
      {meta != null && <span className="ui-list-row__meta">{meta}</span>}
      {trailing != null && <div className="ui-list-row__trailing">{trailing}</div>}
    </div>
  );
}

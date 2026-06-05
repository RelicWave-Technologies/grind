import type { ReactNode } from 'react';
import { cx } from './util';

/* §5.3 Card — the default surface container. Hairline, no shadow, no hover-lift.
   `flush` = padding 0 (host a Table or StatRow); `quiet` = borderless grouping. */
export type CardVariant = 'default' | 'flush' | 'quiet';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  action?: ReactNode;
  variant?: CardVariant;
  children?: ReactNode;
}

export function Card({
  title,
  action,
  variant = 'default',
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cx(
        'ui-card',
        variant === 'flush' && 'ui-card--flush',
        variant === 'quiet' && 'ui-card--quiet',
        className,
      )}
      {...rest}
    >
      {(title != null || action != null) && (
        <div className="ui-card__head">
          {title != null && <h2 className="ui-card__title ui-t-title">{title}</h2>}
          {action != null && <div className="ui-card__action">{action}</div>}
        </div>
      )}
      <div className="ui-card__body">{children}</div>
    </div>
  );
}

/** Alias — the spec names this pattern "Card/Panel". */
export const Panel = Card;

import type { ReactNode } from 'react';
import { cx } from './util';

/* §5.4 Stat + StatRow — the metric pattern. One headline number with an eyebrow
   label and optional delta. Replaces every `*-stat` page class. */

export interface StatDelta {
  dir: 'up' | 'down';
  value: ReactNode;
}

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
}

export function Stat({ label, value, unit, delta, hint, className, ...rest }: StatProps) {
  return (
    <div className={cx('ui-stat', className)} {...rest}>
      <span className="ui-stat__label ui-t-eyebrow">{label}</span>
      <div className="ui-stat__value">
        <span className="ui-t-num">{value}</span>
        {unit != null && <span className="ui-stat__unit">{unit}</span>}
        {delta != null && (
          <span
            className={cx(
              'ui-stat__delta',
              delta.dir === 'up' ? 'ui-stat__delta--up' : 'ui-stat__delta--down',
            )}
          >
            <span aria-hidden>{delta.dir === 'up' ? '▲' : '▼'}</span>
            {delta.value}
          </span>
        )}
      </div>
      {hint != null && <span className="ui-stat__hint ui-t-small">{hint}</span>}
    </div>
  );
}

/* StatRow — groups N Stats inside ONE flush Card, divided by vertical hairlines
   (not separate boxes). Place inside <Card variant="flush">. */
export interface StatRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function StatRow({ children, className, ...rest }: StatRowProps) {
  return (
    <div className={cx('ui-stat-row', className)} {...rest}>
      {children}
    </div>
  );
}

/** The rarer boxed-card layout: auto-fit grid of Stat-in-Card. Layout only. */
export interface StatGridProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function StatGrid({ children, className, ...rest }: StatGridProps) {
  return (
    <div className={cx('ui-stat-grid', className)} {...rest}>
      {children}
    </div>
  );
}

import { cx } from './util';

/* §5.14 Skeleton + Spinner — the only loading treatments.
   Never a full-page spinner: page chrome renders, content fills with skeletons
   sized to the final element. Spinner is for inline button-busy only. */

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px. Default 14 (the button-busy size). */
  size?: number;
}

export function Spinner({ size = 14, className, style, ...rest }: SpinnerProps) {
  return (
    <span
      className={cx('ui-spinner', className)}
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size, ...style }}
      {...rest}
    />
  );
}

export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {
  w?: number | string;
  h?: number | string;
  radius?: number | string;
  /** Disable the shimmer (e.g. for very small chips). Default shimmering. */
  shimmer?: boolean;
}

export function Skeleton({
  w = '100%',
  h = 14,
  radius,
  shimmer = true,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <span
      className={cx('ui-skeleton', shimmer && 'ui-skeleton--shimmer', className)}
      aria-hidden
      style={{ width: w, height: h, ...(radius != null ? { borderRadius: radius } : null), ...style }}
      {...rest}
    />
  );
}

/** Convenience: a block of skeleton rows sized for a Table body. */
export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ui-skeleton-table" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={20} />
      ))}
    </div>
  );
}

/** Convenience: a skeleton sized for a single Stat. */
export function SkeletonStat() {
  return (
    <div className="ui-skeleton-stat" aria-hidden>
      <Skeleton w={64} h={11} />
      <Skeleton w={120} h={28} />
    </div>
  );
}

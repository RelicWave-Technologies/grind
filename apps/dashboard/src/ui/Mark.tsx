import type { SVGProps } from 'react';
import { TIMO_MARK } from '@grind/design/intro';
import { cx } from './util';

/**
 * The Timo mark (DESIGN.md §9 The logo). `write` is the loader: the mark
 * writing itself, the only waiting motion in Timo. Geometry and timing live in
 * @grind/design; this only renders them.
 */
export function TimoMark({
  size = 28,
  motion = 'still',
  tone = 'colour',
  className,
  ...rest
}: {
  size?: number;
  motion?: 'still' | 'write';
  tone?: 'colour' | 'night' | 'mono';
} & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>) {
  return (
    <svg
      className={cx('timo-mark', motion === 'write' && 'timo-mark--write', tone !== 'colour' && `timo-mark--${tone}`, className)}
      width={size}
      height={size}
      viewBox={TIMO_MARK.viewBox}
      aria-hidden="true"
      {...rest}
    >
      <rect className="tm-bar" {...TIMO_MARK.bar} />
      <rect className="tm-moment" {...TIMO_MARK.moment} />
      <rect className="tm-stem" {...TIMO_MARK.stem} />
    </svg>
  );
}

/** A page-sized wait: the mark writing, shown only after 250ms so a fast load never flashes it. */
export function PageLoader({ label }: { label?: string }) {
  return (
    <div className="timo-page-loader" role="status" aria-label={label ?? 'Loading'}>
      <TimoMark size={48} motion="write" />
      {label && <span>{label}</span>}
    </div>
  );
}

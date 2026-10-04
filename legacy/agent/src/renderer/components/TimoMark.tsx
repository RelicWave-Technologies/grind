import type { SVGProps } from 'react';
import { TIMO_MARK } from '@grind/design/intro';

/**
 * The Timo mark (DESIGN.md §9 The logo). `write` is the loader: the mark
 * writing itself, the only waiting motion in Timo. Geometry and timing live in
 * @grind/design; this only renders them.
 */
export default function TimoMark({
  size = 28,
  motion = 'still',
  tone = 'colour',
  className = '',
  ...rest
}: {
  size?: number;
  motion?: 'still' | 'write';
  tone?: 'colour' | 'night' | 'mono';
} & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>) {
  const classes = ['timo-mark', motion === 'write' && 'timo-mark--write', tone !== 'colour' && `timo-mark--${tone}`, className].filter(Boolean).join(' ');
  return (
    <svg className={classes} width={size} height={size} viewBox={TIMO_MARK.viewBox} aria-hidden="true" {...rest}>
      <rect className="tm-bar" {...TIMO_MARK.bar} />
      <rect className="tm-moment" {...TIMO_MARK.moment} />
      <rect className="tm-stem" {...TIMO_MARK.stem} />
    </svg>
  );
}

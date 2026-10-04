/**
 * The Timo mark (DESIGN.md §9 The logo), drawn inline rather than as an <img>
 * so its three parts can move on their own: the bar writes itself, the stem
 * drops, and the moment, now, arrives last. Geometry is the 64 grid of
 * apps/agent/src/renderer/assets/timo-logo.svg.
 */

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

export function TimoMark({ size, className, onDark = false }: { size: number; className?: string; onDark?: boolean }) {
  return (
    <svg
      className={`timo-mark${onDark ? ' timo-mark--on-dark' : ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <rect className="timo-mark-bar" x="7" y="10" width="30" height="12" rx="6" />
      <rect className="timo-mark-now" x="41" y="10" width="16" height="12" rx="6" />
      <rect className="timo-mark-stem" x="26" y="26" width="12" height="29" rx="6" />
    </svg>
  );
}

/**
 * The mark drawing itself, once: the bar writes from the left, the stem drops
 * under it, then now pops in at the end of the bar. Resolves when now has
 * landed. The same beat as the end of every Timo film.
 */
export function assembleMark(svg: SVGSVGElement, delay = 0): Promise<void> {
  const bar = svg.querySelector<SVGRectElement>('.timo-mark-bar');
  const stem = svg.querySelector<SVGRectElement>('.timo-mark-stem');
  const now = svg.querySelector<SVGRectElement>('.timo-mark-now');
  if (!bar || !stem || !now) return Promise.resolve();
  bar.animate(
    [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
    { duration: 460, delay, easing: EASE, fill: 'backwards' },
  );
  stem.animate(
    [{ transform: 'translateY(-10px) scaleY(0.2)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 420, delay: delay + 260, easing: EASE, fill: 'backwards' },
  );
  const pop = now.animate(
    [
      { transform: 'scale(0.2)', opacity: 0 },
      { transform: 'scale(1.18)', opacity: 1, offset: 0.6 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 420, delay: delay + 560, easing: EASE, fill: 'backwards' },
  );
  return pop.finished.then(() => undefined, () => undefined);
}

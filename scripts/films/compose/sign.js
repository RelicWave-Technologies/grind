// sign.js — the close every Timo film ends on, and the landing page's footer echoes: the mark
// draws itself at the centre (the bar writes, the stem drops, now pops in), then slides left
// as "Timo" swipes out from behind it. Drawn per frame, like everything in a composition.
//
//   const sign = makeSign(container)   builds the markup once
//   sign(f, at)                        draws frame f of a sign that starts at frame `at`
//   SIGN_LENGTH                        frames from the first stroke to the settled sign

import { p, mix, css, ease } from './kit.js';

export const SIGN_LENGTH = 62;

export function makeSign(root) {
  root.classList.add('sign');
  root.innerHTML = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect class="bar" x="7" y="10" width="30" height="12" rx="6" />
      <rect class="now" x="41" y="10" width="16" height="12" rx="6" />
      <rect class="stem" x="26" y="26" width="12" height="29" rx="6" />
    </svg>
    <div class="word"><span>Timo</span></div>`;
  const svg = root.querySelector('svg');
  const [bar, now, stem] = root.querySelectorAll('rect');
  const word = root.querySelector('.word');
  const inner = word.querySelector('span');
  let shift = null;

  return (f, at) => {
    // The mark starts where the whole sign's middle will be.
    if (shift === null) shift = (word.offsetWidth + 22) / 2;
    const t = f - at;
    root.style.visibility = t >= 0 ? 'visible' : 'hidden';
    if (t < 0) return;
    const b = p(t, 0, 14, ease.outQuint);
    const s = p(t, 8, 20, ease.outQuint);
    const n = p(t, 17, 29, ease.back);
    css(bar, { transform: `scaleX(${b})` });
    css(stem, { opacity: String(s), transform: `translateY(${mix(-10, 0, s)}px) scaleY(${mix(0.2, 1, s)})` });
    css(now, { opacity: String(Math.min(1, n * 2)), transform: `scale(${mix(0.2, 1, n)})` });
    const go = p(t, 34, 58, ease.outQuint);
    css(svg, { transform: `translateX(${mix(shift, 0, go)}px)` });
    css(inner, { transform: `translateX(${mix(-104, 0, go)}%)` });
  };
}

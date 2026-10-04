// feature.js — the shared shape of the Timo section films (desktop, day, team), after the Crux
// films' own: a short opener the film draws itself, then the real app (a plate) in a window
// with one big caption per plate beat, then the window leaves, a tagline lands, and the film
// closes on the sign (sign.js). Everything clears at the very end so the loop dissolves back
// into the empty opener.
//
//   feature({ plate, plateFrames, opener, caps, tagline, app, poster, render })
//     opener   frames the film's own opener runs before the window rises
//     caps     [{ at, eyebrow, title }] in plate frames; each holds until the next one
//     tagline  the line before the sign (HTML)
//     app      the window's box on the 1920×1080 frame: { top, left, width, height, lights }
//     render   (f) => void, the film's own drawing for the opener (and anything else)

import { p, mix, clamp, css, ease, show, plateFrame } from './kit.js';
import { makeSign, SIGN_LENGTH } from './sign.js';

const $ = (id) => document.getElementById(id);
const RISE = 34; // frames the window takes to rise

export function feature({ plate, plateFrames, opener, caps, tagline, app, poster, render }) {
  const plate0 = opener + 6;
  const end = plate0 + plateFrames; // the plate's last frame; the window leaves from here
  const T = {
    out: [end, end + 22],
    tag: [end + 12, end + 30],
    tagOut: [end + 64, end + 76],
    sign: end + 74,
  };
  const settled = T.sign + SIGN_LENGTH;
  const frames = settled + 44;
  T.clear = [frames - 22, frames - 10];

  const win = $('app');
  css(win, { top: `${app.top}px`, left: `${app.left}px`, width: `${app.width}px`, height: `${app.height}px` });
  if (app.lights) win.insertAdjacentHTML('afterbegin', '<span class="lights"><i></i><i></i><i></i></span>');

  const box = $('caps');
  const els = caps.map((c) => {
    const el = document.createElement('div');
    el.className = 'fcap';
    el.innerHTML = `<span class="eyebrow">${c.eyebrow}</span><h2 class="display">${c.title}</h2>`;
    css(el, { left: `${app.left}px` });
    box.append(el);
    return el;
  });
  $('tagline').innerHTML = tagline;
  const sign = makeSign($('sign'));

  window.FILM = { frames, poster: poster ?? plate0 + 60, loop: 16 };

  window.render = async (f) => {
    render?.(f);
    const pf = f - plate0;

    // The window rises in a slight tilt, and sinks away at the end.
    const inn = p(f, opener - 6, opener - 6 + RISE, ease.outQuint);
    const out = p(f, ...T.out, ease.inOut);
    css(win, {
      opacity: String(clamp(inn * 3) * (1 - out)),
      transform: `translateY(${mix(420, 0, inn) + mix(0, 260, out)}px) rotateX(${mix(18, 0, inn)}deg) scale(${mix(0.9, 1, inn)})`,
    });
    win.style.visibility = f >= opener - 8 && f <= T.out[1] + 2 ? 'visible' : 'hidden';

    els.forEach((el, k) => {
      const a = caps[k].at;
      const b = k + 1 < caps.length ? caps[k + 1].at : Infinity;
      const start = k === 0 ? Math.min(a, -8) : a;
      const on = p(pf, start, start + 16, ease.outQuint);
      const off = b === Infinity ? p(f, end - 6, end + 8) : p(pf, b - 8, b + 2);
      css(el, { opacity: String(on * (1 - off)), transform: `translateY(${mix(26, 0, on) - mix(0, 18, off)}px)` });
    });

    const tg = p(f, ...T.tag, ease.outQuint) * (1 - p(f, ...T.tagOut, ease.inOut));
    css($('tagline'), { opacity: String(tg), transform: `translateY(${mix(30, 0, p(f, ...T.tag, ease.outQuint)) - mix(0, 24, p(f, ...T.tagOut))}px)` });

    sign(f, T.sign);
    css($('sign'), { opacity: String(1 - p(f, ...T.clear, ease.inOut)) });

    if (f >= opener - 8 && f <= T.out[1] + 2) await show($('plate'), plateFrame(plate, pf, plateFrames));
  };

  return { plate0, frames, end, T };
}

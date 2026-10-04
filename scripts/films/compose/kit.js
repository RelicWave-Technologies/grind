// kit.js — the timing vocabulary every composition shares.
//
// A composition is a page whose picture is a pure function of the frame number: `render(f)`
// sets every style from `f` alone, so the same frame renders the same picture every time and a
// fix is a re-render. Nothing here uses CSS transitions, CSS animations or timers.

export const FPS = 30;
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const mix = (a, b, t) => a + (b - a) * t;

export const ease = {
  linear: (t) => t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: (t) => t * t * t,
  back: (t) => {
    const c1 = 1.9,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  expo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};

/** Progress of frame `f` through [a, b], eased. 0 before `a`, 1 after `b`. */
export const p = (f, a, b, e = ease.out) => e(clamp((f - a) / (b - a)));

/** Set several inline styles at once. */
export const css = (el, styles) => {
  for (const k in styles) el.style[k] = styles[k];
};

/** A deterministic random stream, so every render draws the same "random" pattern. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split a container's text into word spans, keeping any `<mark>` elements whole, so a stream
 * can reveal one word per step. Returns the ordered list of units.
 */
export function words(el) {
  const units = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const parts = child.textContent.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (part === '') continue;
          if (/^\s+$/.test(part)) {
            frag.append(document.createTextNode(part));
            continue;
          }
          const s = document.createElement('span');
          s.className = 'w';
          s.textContent = part;
          frag.append(s);
          units.push(s);
        }
        child.replaceWith(frag);
      } else if (
        child.nodeType === 1 &&
        (child.tagName === 'MARK' || child.classList.contains('unit'))
      ) {
        units.push(child);
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(el);
  return units;
}

/** Set an <img> to a new file and wait until it has decoded, so the frame never shows a gap. */
const loaded = new Map();
export async function show(img, src) {
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.src = src;
  await img.decode().catch(() => {});
  loaded.set(img, src);
}

/** Path of frame `i` of a plate, clamped to the frames that exist. */
export function plateFrame(dir, i, count) {
  const n = Math.max(0, Math.min(count - 1, Math.round(i)));
  return `${dir}/final/${String(n).padStart(5, '0')}.jpg`;
}

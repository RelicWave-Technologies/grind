// plate.mjs — films the real Timo app (the mock dashboard or the Agent Lab), one screenshot per frame, as a "plate" that the
// composer later places inside a motion-designed shot.
//
// It is the skill's stage.js (app-walkthrough-video) with one addition that a real app needs: a film
// clock for the page's own motion. The app animates with CSS — drawers slide, loaders sweep, the
// setup preview loops — and a frame here takes ~70 ms to capture, so left alone those
// animations would run at the wrong speed and differently on every render. Before each frame,
// every animation on the page is paused and set to the film's time, counted from the frame it
// first appeared on. The result: a drawer that takes 320 ms opens over ten frames, every time.
//
// Timo's own clocks (the desktop timer, "since 9:42") read Date and run on timers, so a plate
// made with `clock: true` also freezes the page's clock and moves it on exactly one film frame
// per shot (Playwright's page.clock, installed before the page loaded). A timer on film then
// ticks at its real speed, every render.
//
// Camera and cursor work in layout px, as in stage.js. The cursor is drawn inside the camera.

import fs from 'node:fs';
import path from 'node:path';

export const FPS = 30;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

export async function createPlate(page, options = {}) {
  const o = {
    outDir: 'plate/frames',
    quality: 92,
    ringColor: '47,111,208',
    hide: [],
    clock: false,
    ...options,
  };
  fs.rmSync(o.outDir, { recursive: true, force: true });
  fs.mkdirSync(o.outDir, { recursive: true });

  await page.evaluate(
    ({ hide, ringColor }) => {
      const B = document.body;
      const W = innerWidth,
        H = innerHeight;
      document.documentElement.style.cssText += ';overflow:hidden';
      Object.assign(B.style, {
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        transformOrigin: '0 0',
      });

      const scrub = () => {
        for (const sel of hide)
          document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
      };
      scrub();
      new MutationObserver(scrub).observe(B, { childList: true, subtree: true });

      window.__t = { tx: 0, ty: 0, s: 1 };
      window.__setCam = (x, y, s) => {
        let tx = W / 2 - s * x,
          ty = H / 2 - s * y;
        tx = Math.min(0, Math.max(W - s * W, tx));
        ty = Math.min(0, Math.max(H - s * H, ty));
        B.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
        window.__t = { tx, ty, s };
      };
      window.__lr = (el) => {
        const r = el.getBoundingClientRect(),
          { tx, ty, s } = window.__t;
        return { x: (r.x - tx) / s, y: (r.y - ty) / s, w: r.width / s, h: r.height / s };
      };

      const cur = document.createElement('div');
      cur.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.6 25.2 L16.8 23.8 L13.2 16.3 L20.2 16.3 Z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      Object.assign(cur.style, {
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 2147483647,
        pointerEvents: 'none',
        transformOrigin: '5px 3px',
        filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.28))',
      });
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'absolute',
        zIndex: 2147483646,
        pointerEvents: 'none',
        borderRadius: '50%',
        background: `rgba(${ringColor},.22)`,
        border: `2px solid rgba(${ringColor},.55)`,
        opacity: 0,
      });
      B.append(ring, cur);
      window.__setCur = (x, y, op, press, rp) => {
        cur.style.transform = `translate(${x - 5}px,${y - 3}px) scale(${1 - 0.14 * press})`;
        cur.style.opacity = String(op);
        if (rp > 0 && rp < 1) {
          const d = 14 + 46 * rp;
          Object.assign(ring.style, {
            left: `${x - d / 2}px`,
            top: `${y - d / 2}px`,
            width: `${d}px`,
            height: `${d}px`,
            opacity: String(1 - rp),
          });
        } else ring.style.opacity = 0;
      };

      // The film clock. An animation's time is film time since the frame it was first seen.
      const born = new Map();
      const settled = new WeakSet();
      window.__filmTick = (ms) => {
        for (const a of document.getAnimations()) {
          if (settled.has(a)) continue;
          if (!born.has(a)) born.set(a, ms);
          a.pause();
          a.currentTime = ms - born.get(a);
        }
      };
      // Finish everything already running, so a plate opens on a settled screen.
      window.__settle = () => {
        for (const a of document.getAnimations()) {
          const t = a.effect?.getComputedTiming();
          if (t && t.iterations !== Infinity) {
            try {
              a.finish();
              settled.add(a);
            } catch {
              /* an infinite one */
            }
          }
        }
      };
    },
    { hide: o.hide, ringColor: o.ringColor },
  );

  const view = page.viewportSize();
  const cam = { x: view.width / 2, y: view.height / 2, s: 1 };
  const cur = { x: view.width + 60, y: view.height * 0.7, o: 1, press: 0, rp: 0 };
  const cuts = [];
  const marks = {};
  let frame = 0;

  async function apply() {
    await page.evaluate(
      ([c, u]) => {
        window.__setCam(c.x, c.y, c.s);
        window.__setCur(u.x, u.y, u.o, u.press, u.rp);
      },
      [cam, cur],
    );
    const t = await page.evaluate(() => window.__t);
    await page.mouse.move(cur.x * t.s + t.tx, cur.y * t.s + t.ty);
  }

  async function shot() {
    if (o.clock) await page.clock.runFor(1000 / FPS);
    await page.evaluate((ms) => window.__filmTick(ms), (frame * 1000) / FPS);
    await page.screenshot({
      path: path.join(o.outDir, `${String(frame).padStart(5, '0')}.jpg`),
      type: 'jpeg',
      quality: o.quality,
    });
    frame += 1;
  }

  async function tween(n, to = {}, each) {
    const c0 = { ...cam },
      u0 = { ...cur };
    const ease = to.ease ?? easeInOut;
    for (let i = 1; i <= n; i += 1) {
      const t = ease(i / n);
      if (to.cam)
        for (const k of ['x', 'y', 's'])
          if (to.cam[k] !== undefined) cam[k] = lerp(c0[k], to.cam[k], t);
      if (to.cur) {
        for (const k of ['x', 'y', 'o'])
          if (to.cur[k] !== undefined) cur[k] = lerp(u0[k], to.cur[k], t);
        if (to.cur.x !== undefined || to.cur.y !== undefined)
          cur.y += Math.sin(Math.PI * t) * (to.arc ?? -40);
      }
      if (each) await each(i, n);
      await apply();
      await shot();
    }
  }

  const hold = (n, each) => tween(n, {}, each);
  const rect = (locator) => locator.evaluate((el) => window.__lr(el));
  const mark = (name) => {
    marks[name] = frame;
  };

  async function focus(
    locator,
    { scale = 1.6, frames = 28, dx = 0, dy = 0, cursor = false } = {},
  ) {
    const r = await rect(locator);
    const to = { cam: { x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, s: scale } };
    if (cursor) to.cur = { x: r.x + r.w / 2, y: r.y + r.h / 2, o: 1 };
    await tween(frames, to);
    return r;
  }

  async function moveTo(locator, { frames = 20, at, arc } = {}) {
    const r = await rect(locator);
    const p = at
      ? { x: r.x + at.x, y: r.y + at.y }
      : { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    await tween(frames, { cur: { ...p, o: 1 }, arc });
    return r;
  }

  /**
   * Press, ripple, then the real click. With `changes`, the ripple is drawn before the click so
   * it never lands on the next screen, and a crossfade of that many frames is recorded.
   */
  async function click(locator, { changes = 0, settleMs = 250 } = {}) {
    for (const press of [0.5, 1]) {
      cur.press = press;
      await apply();
      await shot();
    }
    if (!changes) await locator.click({ force: true });
    cur.press = 0;
    for (let i = 1; i <= 9; i += 1) {
      cur.rp = i / 10;
      await apply();
      await shot();
    }
    cur.rp = 0;
    if (changes) {
      await locator.click({ force: true });
      cuts.push({ at: frame - 1, len: changes });
    }
    await page.waitForTimeout(settleMs);
  }

  async function type(text, { perFrame = 1 } = {}) {
    for (let i = 0; i < text.length; i += perFrame) {
      await page.keyboard.type(text.slice(i, i + perFrame));
      await apply();
      await shot();
    }
  }

  /** Record a crossfade into the next frame, for a screen change the film did not click. */
  const cut = (len = 8) => cuts.push({ at: frame - 1, len });

  /**
   * Scroll the page so `locator` sits `top` px below the viewport's top, eased over `frames`
   * frames, whichever element actually scrolls (the window, or an app's own scroll pane).
   */
  async function scrollInto(locator, { top = 120, frames = 30 } = {}) {
    const plan = await locator.evaluate((el, top) => {
      let pane = el.parentElement;
      while (pane && pane !== document.body) {
        const st = getComputedStyle(pane);
        if (/(auto|scroll)/.test(st.overflowY) && pane.scrollHeight > pane.clientHeight) break;
        pane = pane.parentElement;
      }
      // The plate pins <body> to the viewport with overflow hidden, so a page that scrolled the
      // window now scrolls <body>.
      if (!pane) pane = document.body;
      window.__pane = pane;
      const base = pane === document.body ? 0 : pane.getBoundingClientRect().top;
      return { from: pane.scrollTop, by: el.getBoundingClientRect().top - base - top };
    }, top);
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    await tween(frames, {}, async (i, n) => {
      await page.evaluate((y) => {
        window.__pane.scrollTop = y;
      }, plan.from + plan.by * ease(i / n));
    });
  }

  const scrollTo = (locator, top) =>
    locator.evaluate((el, y) => {
      el.scrollTop = y;
    }, top);

  function finish(extra = {}) {
    const meta = {
      frames: frame,
      cuts,
      marks,
      fps: FPS,
      width: view.width,
      height: view.height,
      ...extra,
    };
    fs.writeFileSync(
      path.join(path.dirname(o.outDir), 'cuts.json'),
      JSON.stringify(meta, null, 2),
    );
    return meta;
  }

  if (o.clock) {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
  }
  await apply();
  return {
    page,
    cam,
    cur,
    apply,
    shot,
    tween,
    hold,
    rect,
    mark,
    focus,
    moveTo,
    click,
    type,
    scrollTo,
    scrollInto,
    cut,
    finish,
    get frame() {
      return frame;
    },
  };
}

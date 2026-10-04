/**
 * The Timo mark in motion (DESIGN.md §9 The logo, Motion): its geometry, the
 * writing loop's timing, and the app-load intro that flies the mark into the
 * page's own logo. Framework-free on purpose: each app renders the mark and
 * the overlay with its own React (pnpm hoists a separate copy per app), and
 * hands the elements to `createIntro`, which owns every timing decision.
 */

/** The mark on its 64 grid: a capital T whose bar is a day ribbon, the moment (now) at its end. */
export const TIMO_MARK = {
  viewBox: '0 0 64 64',
  bar: { x: 7, y: 10, width: 30, height: 12, rx: 6 },
  moment: { x: 41, y: 10, width: 16, height: 12, rx: 6 },
  stem: { x: 26, y: 26, width: 12, height: 29, rx: 6 },
} as const;

/** One writing loop (mark.css `--timo-mark-cycle`): bar, stem, moment, hold, fade. */
export const MARK_CYCLE_MS = 2000;
/** The stretch of the loop where the whole mark is drawn and still (56%–80%). */
const DRAWN_FROM_MS = 0.56 * MARK_CYCLE_MS;
const DRAWN_TO_MS = 0.8 * MARK_CYCLE_MS;

const FLIGHT_MS = 780;
const FADE_MS = 520;
const FADE_DELAY_MS = 260;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** If something holds the intro this long, the app is shown anyway. */
const MAX_HOLD_MS = 8000;

export type IntroPhase = 'loading' | 'leaving' | 'done';

export interface Intro {
  /** Something is still loading; call the returned function when it is ready. */
  hold(): () => void;
  /** The overlay and the mark's holder are on screen; timing starts now. */
  mount(overlay: HTMLElement, holder: HTMLElement): void;
  /** Stop timers and animations (unmount). */
  dispose(): void;
}

/** True where the flight cannot or should not play: reduced motion, or no Web Animations (tests). */
export function introSkipped(): boolean {
  if (typeof window === 'undefined') return true;
  if (typeof Element.prototype.animate !== 'function') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The app-load intro. While anything holds it, the mark writes itself on a
 * white overlay. Once nothing holds it, it waits for the next moment the mark
 * is fully drawn (so the first loop always reaches its full shape and the
 * hand-off never jumps), freezes there, and flies into the element marked
 * `data-intro-target` while the overlay fades to show the app beneath. Then
 * the real logo is shown and the overlay is told to go.
 */
export function createIntro(onPhase: (phase: IntroPhase) => void): Intro {
  let holds = 0;
  let phase: IntroPhase = 'loading';
  let overlay: HTMLElement | null = null;
  let holder: HTMLElement | null = null;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  const running: Animation[] = [];

  const set = (next: IntroPhase) => {
    if (phase === next) return;
    phase = next;
    onPhase(next);
  };

  const schedule = () => {
    clearTimeout(timer);
    if (phase !== 'loading' || overlay === null || holds > 0) return;
    const elapsed = performance.now() - started;
    const into = elapsed % MARK_CYCLE_MS;
    const ready = elapsed >= DRAWN_FROM_MS && into >= DRAWN_FROM_MS && into <= DRAWN_TO_MS - 60;
    const wait = ready ? 0 : into < DRAWN_FROM_MS ? DRAWN_FROM_MS - into : MARK_CYCLE_MS - into + DRAWN_FROM_MS;
    timer = setTimeout(leave, wait);
  };

  const leave = () => {
    clearTimeout(timer);
    clearTimeout(cap);
    if (phase !== 'loading' || overlay === null || holder === null) return;
    set('leaving');
    // The mark is drawn and still from here (the app switches it to `still`).
    const cover = overlay;
    const box = holder;
    const target = document.querySelector<HTMLElement>('[data-intro-target]');
    const page = getComputedStyle(cover).backgroundColor;
    cover.style.pointerEvents = 'none';

    if (target !== null) {
      target.classList.add('is-intro-hidden');
      const first = box.getBoundingClientRect();
      const last = target.getBoundingClientRect();
      const travel = `translate(${last.left - first.left}px, ${last.top - first.top}px) scale(${last.width / first.width})`;
      running.push(box.animate([{ transform: 'none' }, { transform: travel }], { duration: FLIGHT_MS, easing: EASE, fill: 'forwards' }));
    }
    const fade = cover.animate(
      [
        { backgroundColor: page, opacity: 1 },
        { backgroundColor: 'rgb(0 0 0 / 0)', opacity: target === null ? 0 : 1 },
      ],
      { duration: FADE_MS, delay: target === null ? 0 : FADE_DELAY_MS, easing: EASE, fill: 'forwards' },
    );
    running.push(fade);
    void Promise.all(running.map((a) => a.finished))
      .then(() => {
        target?.classList.remove('is-intro-hidden');
        set('done');
      })
      .catch(() => {
        target?.classList.remove('is-intro-hidden');
      });
  };

  if (introSkipped()) {
    phase = 'done';
    queueMicrotask(() => onPhase('done'));
  }

  return {
    hold() {
      holds += 1;
      clearTimeout(timer);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        schedule();
      };
    },
    mount(o, h) {
      if (phase !== 'loading') return;
      overlay = o;
      holder = h;
      started = performance.now();
      cap = setTimeout(leave, MAX_HOLD_MS);
      schedule();
    },
    dispose() {
      clearTimeout(timer);
      clearTimeout(cap);
      for (const a of running) a.cancel();
      document.querySelector('[data-intro-target].is-intro-hidden')?.classList.remove('is-intro-hidden');
    },
  };
}

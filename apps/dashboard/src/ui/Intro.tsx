import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createIntro, introSkipped, type Intro, type IntroPhase } from '@grind/design/intro';
import { TimoMark } from './Mark';

const IntroContext = createContext<Intro | null>(null);

/**
 * The app-load intro (DESIGN.md §9 Motion): the mark writes itself on a white
 * cover while anything below holds it, then flies into the element marked
 * `data-intro-target` (the sidebar logo). The app renders beneath the cover
 * the whole time. All timing is in @grind/design/intro. With `enabled` false
 * (a public page) nothing is drawn and holds are no-ops.
 */
export function IntroProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [phase, setPhase] = useState<IntroPhase>(() => (!enabled || introSkipped() ? 'done' : 'loading'));
  const [intro] = useState(() => (enabled ? createIntro(setPhase) : null));
  const cover = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (intro && cover.current && holder.current) intro.mount(cover.current, holder.current);
    return () => intro?.dispose();
  }, [intro]);

  return (
    <IntroContext.Provider value={intro}>
      {children}
      {phase !== 'done' && (
        <div className="timo-intro" ref={cover} role="status" aria-label="Opening Timo">
          <div className="timo-intro__mark" ref={holder}>
            <TimoMark size={96} motion={phase === 'loading' ? 'write' : 'still'} />
          </div>
        </div>
      )}
    </IntroContext.Provider>
  );
}

/** Keep the intro on screen while `waiting` is true (the session, the first page's data). */
export function useIntroHold(waiting: boolean): void {
  const intro = useContext(IntroContext);
  useEffect(() => {
    if (!waiting || intro === null) return;
    return intro.hold();
  }, [waiting, intro]);
}

/** Spread onto the logo the intro flies into. */
export const introTarget = { 'data-intro-target': '' } as const;

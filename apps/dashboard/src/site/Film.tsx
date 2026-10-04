import { useEffect, useRef, useState } from 'react';
import { TimoLoader } from './SiteShell';

export interface Chapter {
  label: string;
  /** Seconds into the film where this chapter starts. */
  at: number;
}

/**
 * A Timo film: the real app, filmed from the mock dashboard and the Agent
 * Lab, inside a composition that tells the story in captions
 * (scripts/films/). It plays muted and loops, only while on screen. The mark
 * waits in its place until the film can play; a film that never loads keeps
 * its poster. With chapters, a row of tabs under it tracks the story and
 * jumps to a chapter on click.
 */
export function Film({ name, alt, chapters, hero = false }: { name: string; alt: string; chapters?: Chapter[]; hero?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setReady(true);
    // A phone that will not preload video never fires canplay; after this it
    // keeps its poster rather than a loader that never ends.
    const giveUp = window.setTimeout(() => setReady(true), 12_000);
    if (reduced) return () => window.clearTimeout(giveUp);
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) void v.play().catch(() => undefined);
      else v.pause();
    }, { threshold: 0.25 });
    io.observe(v);
    return () => { io.disconnect(); window.clearTimeout(giveUp); };
  }, [reduced]);

  const active = chapters ? chapters.reduce((a, c, i) => (time >= c.at ? i : a), 0) : -1;

  return (
    <figure className={`film${hero ? ' film--hero' : ''}`}>
      <div className="film-frame">
        <video
          ref={video}
          src={`/films/timo-${name}.mp4`}
          poster={`/films/timo-${name}-poster.webp`}
          width={1920}
          height={1080}
          muted
          loop
          playsInline
          preload={hero ? 'auto' : 'metadata'}
          aria-label={alt}
          onCanPlay={() => setReady(true)}
          onError={() => setReady(true)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={chapters ? (e) => setTime(e.currentTarget.currentTime) : undefined}
        />
        <div className={`film-wait${ready ? ' is-gone' : ''}`} aria-hidden={ready}>
          <TimoLoader size={hero ? 72 : 56} label="Loading the film" />
        </div>
      </div>
      {chapters && (
        <ol className="film-chapters" aria-label="Chapters">
          {chapters.map((c, i) => {
            const end = chapters[i + 1]?.at ?? duration;
            const fill = i < active ? 1 : i > active ? 0 : end > c.at ? (time - c.at) / (end - c.at) : 0;
            return (
              <li key={c.label}>
                <button
                  type="button"
                  className={i === active ? 'is-on' : undefined}
                  onClick={() => {
                    const v = video.current;
                    if (!v) return;
                    v.currentTime = c.at;
                    void v.play().catch(() => undefined);
                  }}
                >
                  <span className="film-chapter-bar"><span style={{ transform: `scaleX(${Math.max(0, Math.min(1, fill))})` }} /></span>
                  {c.label}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </figure>
  );
}

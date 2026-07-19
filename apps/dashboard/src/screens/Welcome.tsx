import './welcome.css';
import { useEffect, useRef, useState } from 'react';

/**
 * /welcome — public landing page (no auth, no app shell).
 * Strictly DESIGN.md: monochrome chrome, display-xl hero, mono taxonomy,
 * pill CTAs, the black marquee, and the documented color-block rhythm —
 * white hero → white feature tiles → lime privacy block → white product
 * shots → navy zero-loss block → coral changelog block → white closing CTA.
 * The animated scenes are faithful miniatures of the real app, drawn by
 * .context/create_timo_app_scenes.py; the dashboard screenshots come from a
 * seeded demo workspace (fictional people). Motion honors reduced-motion.
 */

export function WelcomeScreen() {
  // OS-aware download CTA: Mac and Windows visitors see their own build.
  const [os] = useState<'mac' | 'win' | null>(() => {
    const probe = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
    if (/Mac|iPhone|iPad/i.test(probe)) return 'mac';
    if (/Win/i.test(probe)) return 'win';
    return null;
  });
  const dlLabel = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Get Timo';
  const dlIcon = os === 'mac' ? '/brand/apple.svg' : os === 'win' ? '/brand/windows.svg' : null;
  const dlHref = 'https://github.com/RelicWave-Technologies/grind/releases/latest';

  const carouselRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Timo — keeps time';
    return () => { document.title = prev; };
  }, []);

  // Scroll-driven carousel: vertical scroll sets the target, the track
  // follows with damped inertia, the centered slide takes focus while its
  // neighbours recede, and the mono HUD tracks progress. Falls back to a
  // static column on small screens and under prefers-reduced-motion.
  useEffect(() => {
    const wrap = carouselRef.current;
    const track = trackRef.current;
    if (!wrap || !track) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const slides = Array.from(track.querySelectorAll<HTMLElement>('.wl-slide'));
    const plx = Array.from(document.querySelectorAll<HTMLElement>('[data-plx]'));
    const DWELL = 0.14; // hold the first/last slide centered at the ends
    let current: number | null = null;
    let raf = 0;
    let live = true;
    const loop = () => {
      if (!live) return;
      if (window.innerWidth <= 900) {
        track.style.transform = '';
        slides.forEach((s) => { s.style.transform = ''; s.style.opacity = ''; });
        plx.forEach((el) => { el.style.transform = ''; });
      } else {
        const rect = wrap.getBoundingClientRect();
        const span = wrap.offsetHeight - window.innerHeight;
        const pRaw = span > 0 ? Math.min(1, Math.max(0, -rect.top / span)) : 0;
        const p = Math.min(1, Math.max(0, (pRaw - DWELL) / (1 - 2 * DWELL)));
        // Slide centers in track space — first and last land dead-center.
        const cx = window.innerWidth / 2;
        const centers = slides.map((s) => s.offsetLeft + s.offsetWidth / 2);
        const startX = (centers[0] ?? 0) - cx;
        const endX = (centers[centers.length - 1] ?? 0) - cx;
        const target = startX + (endX - startX) * p;
        current = current === null ? target : current + (target - current) * 0.12;
        if (Math.abs(target - current) < 0.35) current = target;
        track.style.transform = `translate3d(${-current}px, 0, 0)`;
        let active = 0;
        let best = Number.POSITIVE_INFINITY;
        slides.forEach((s, i) => {
          const r = s.getBoundingClientRect();
          const d = Math.abs(r.left + r.width / 2 - cx) / window.innerWidth;
          if (d < best) { best = d; active = i; }
          s.style.transform = `scale(${1 - Math.min(d * 0.12, 0.055)})`;
          s.style.opacity = String(1 - Math.min(d * 0.7, 0.42));
        });
        if (progressRef.current) progressRef.current.style.width = `${p * 100}%`;
        if (counterRef.current) counterRef.current.textContent = `0${active + 1} / 0${slides.length}`;
        // Gentle parallax depth on the block scenes (measured off the
        // untransformed parent so it never feeds back).
        plx.forEach((el) => {
          const speed = Number(el.dataset.plx || 0);
          const pr = (el.parentElement as HTMLElement).getBoundingClientRect();
          const d = pr.top + pr.height / 2 - window.innerHeight / 2;
          el.style.transform = `translate3d(0, ${(-d * speed).toFixed(1)}px, 0)`;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { live = false; cancelAnimationFrame(raf); };
  }, []);

  // Scroll reveal — sections rise in as they enter (DESIGN.md thumbnails
  // animate in on scroll).
  useEffect(() => {
    const els = document.querySelectorAll('.wl-reveal');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('wl-in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.06 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="wl-page">
      {/* ---- Top nav (56px white, pill pair right) ------------------------- */}
      <nav className="wl-nav">
        <div className="wl-nav-inner">
          <a className="wl-nav-brand" href="/">
            <img src="/brand/timo-mascot.svg" alt="" width={30} height={30} />
            <span>Timo</span>
          </a>
          <div className="wl-nav-links">
            <a href="#privacy">Privacy</a>
            <a href="#dashboard">Dashboard</a>
            <a href="/changelog">Changelog</a>
          </div>
          <div className="wl-nav-ctas">
            <a className="wl-btn wl-btn--secondary" href="/home">Open dashboard</a>
            <a className="wl-btn wl-btn--primary wl-btn--dl" href={dlHref} target="_blank" rel="noreferrer">
              {dlIcon && <img src={dlIcon} alt="" width={15} height={15} />}
              Download
            </a>
          </div>
        </div>
      </nav>

      <main>
        {/* ---- The hero ---------------------------------------------------- */}
        <header className="wl-hero">
          <div className="wl-container wl-hero-grid">
            <div className="wl-copy">
              <h1 className="wl-display rise-1">
                <span>Timo keeps time.</span>
                <span>You keep shipping.</span>
              </h1>
              <p className="wl-lead rise-2">
                A time tracker your team won't quietly resent. Real hours,
                honest screenshots, approvals in Lark, and absolutely no
                opinions about your lunch break.
              </p>
              <div className="wl-ctas rise-3">
                <a className="wl-btn wl-btn--primary wl-btn--dl" href={dlHref} target="_blank" rel="noreferrer">
                  {dlIcon && <img src={dlIcon} alt="" width={17} height={17} />}
                  {dlLabel}
                </a>
                <a className="wl-btn wl-btn--secondary" href="/home">Open the dashboard</a>
              </div>
            </div>

            {/* Cream color block: the real app, floating as sticky notes. */}
            <div className="wl-stage rise-2">
              <div className="wl-stage-block" aria-hidden="true" />
              <span className="wl-fleck wl-fleck--1" aria-hidden="true" />
              <span className="wl-fleck wl-fleck--2" aria-hidden="true" />
              <span className="wl-fleck wl-fleck--3" aria-hidden="true" />
              <figure className="wl-card wl-card--a">
                <img src="/brand/timo-scene-timer.gif?v=3" alt="The Timo timer running: 00:42 on a task, one click to stop" loading="eager" width={340} height={115} />
              </figure>
              <figure className="wl-card wl-card--b">
                <img src="/brand/timo-scene-task.gif?v=3" alt="A task row: press play, the Tracking chip slides in" loading="eager" width={356} height={95} />
              </figure>
              <figure className="wl-card wl-card--c">
                <img src="/brand/timo-scene-ribbon.gif?v=3" alt="Today's activity ribbon filling with tracked and meeting time" loading="eager" width={372} height={113} />
              </figure>
              <a className="wl-stage-cap" href="/changelog">SCENES FROM THE REAL APP →</a>
            </div>
          </div>
        </header>

        {/* ---- White feature tiles ----------------------------------------- */}
        <section className="wl-sec">
          <div className="wl-container">
            <div className="wl-tiles wl-reveal">
              <div className="wl-tile">
                <p className="wl-caption">REAL HOURS</p>
                <p>Survives crashes, sleep, and whatever your Wi-Fi is doing today. Idle time gets trimmed and the “are you still there?” minute never counts — we're not monsters.</p>
              </div>
              <div className="wl-tile">
                <p className="wl-caption">HONEST SCREENSHOTS</p>
                <p>Taken on a gentle cadence, visible to you first, and shredded after 60 days. Blur or delete your own. Nobody is compiling a blooper reel.</p>
              </div>
              <div className="wl-tile">
                <p className="wl-caption">APPROVALS IN LARK</p>
                <p>Forgot to hit start? Ask once in chat. Your manager taps approve. Nobody schedules a meeting about the meeting you forgot to log.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Lime block: the privacy contract ---------------------------- */}
        <section className="wl-sec" id="privacy">
          <div className="wl-container">
            <div className="wl-block wl-block--lime wl-reveal">
              <div className="wl-block-grid">
                <div>
                  <p className="wl-caption">THE CONTRACT</p>
                  <h2 className="wl-headline">Counts, never content.</h2>
                  <p className="wl-block-body">
                    Timo counts keystrokes, clicks and scroll. It has no idea
                    what you typed, and honestly it isn't curious. No clipboard,
                    no microphone, no camera. Titles and URLs stay off unless an
                    admin says otherwise. And if it ever stops counting, it tells
                    you — loudly, like a smoke alarm with better manners.
                  </p>
                  <p className="wl-caption wl-block-foot">YOUR SECRETS ARE SAFE. TIMO ISN'T INTERESTED.</p>
                </div>
                <figure className="wl-block-scene" data-plx="0.07">
                  <img src="/brand/timo-card-beta28.gif?v=3" alt="A reliability checklist ticking calmly while Timo nods" loading="lazy" width={420} height={169} />
                </figure>
              </div>
            </div>
          </div>
        </section>

        {/* ---- White: the dashboard, real shots ----------------------------- */}
        <section className="wl-sec" id="dashboard">
          <div className="wl-container">
            <h2 className="wl-display-lg wl-reveal">The other half lives in your browser.</h2>
            <p className="wl-sec-lead wl-reveal">
              Managers get the whole workspace at a glance. Everyone else gets
              their own day, minute by minute. These are real screens from a
              demo workspace — the people are made up, the product isn't.
            </p>
          </div>
          <div className="wl-carousel" ref={carouselRef}>
            <div className="wl-car-sticky">
              <div className="wl-car-track" ref={trackRef}>
                <figure className="wl-slide">
                  <img src="/shots/timo-dash-overview.gif?v=3" alt="Timo dashboard overview assembling: KPI tiles land, then the approval and flag queues" loading="lazy" width={760} height={385} />
                  <figcaption className="wl-caption">OVERVIEW — THE WORKSPACE TODAY</figcaption>
                </figure>
                <figure className="wl-slide">
                  <img src="/shots/timo-dash-edit-time.gif?v=3" alt="Edit Time assembling: the day ribbon and heat strip wipe on, timesheet rows cascade in" loading="lazy" width={760} height={385} />
                  <figcaption className="wl-caption">EDIT TIME — YOUR DAY, MINUTE BY MINUTE</figcaption>
                </figure>
                <figure className="wl-slide">
                  <img src="/shots/timo-dash-reports.gif?v=3" alt="Reports assembling: the weekly KPI band lands, daily rows cascade in" loading="lazy" width={760} height={385} />
                  <figcaption className="wl-caption">REPORTS — THE WEEK, HONESTLY</figcaption>
                </figure>
              </div>
              <div className="wl-car-hud" aria-hidden="true">
                <span className="wl-caption" ref={counterRef}>01 / 03</span>
                <div className="wl-car-progress"><div className="wl-car-progress-fill" ref={progressRef} /></div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Navy block: zero-loss story ---------------------------------- */}
        <section className="wl-sec">
          <div className="wl-container">
            <div className="wl-block wl-block--navy wl-reveal">
              <div className="wl-block-grid">
                <div>
                  <p className="wl-caption">THE ENGINEERING</p>
                  <h2 className="wl-headline">Zero-loss timekeeping.</h2>
                  <p className="wl-block-body">
                    Every tick is written to disk before it reaches your screen,
                    and the server only counts minutes it can actually prove. So
                    a crash, a dead network or a fresh laptop can't swallow an
                    hour you really worked — and nobody can conjure one they
                    didn't. Both directions. That's the point.
                  </p>
                  <p className="wl-caption wl-block-foot">YOUR HOURS OUTLIVE YOUR LAPTOP.</p>
                </div>
                <figure className="wl-block-scene wl-block-scene--seamless" data-plx="0.07">
                  <img src="/brand/timo-scene-timer.gif?v=3" alt="The timer card, still counting" loading="lazy" width={460} height={156} />
                </figure>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Coral block: ships often + changelog ------------------------- */}
        <section className="wl-sec">
          <div className="wl-container">
            <div className="wl-block wl-block--coral wl-reveal">
              <div className="wl-block-grid">
                <div>
                  <p className="wl-caption">THE CADENCE</p>
                  <h2 className="wl-headline">Twenty-eight builds in twenty-five days.</h2>
                  <p className="wl-block-body">
                    Timo updates itself. It checks after launch, quietly, and
                    installs when you say so. Twenty-eight builds in twenty-five
                    days — some added features, some fixed what the features
                    broke. We wrote up every single one.
                  </p>
                  <div className="wl-block-ctas">
                    <a className="wl-btn wl-btn--secondary" href="/changelog">Read the changelog</a>
                  </div>
                </div>
                <figure className="wl-block-scene wl-block-scene--card" data-plx="0.07">
                  <img src="/brand/timo-card-beta24.gif?v=3" alt="Timo rides the update rail from OLD to NEW and back" loading="lazy" width={440} height={149} />
                </figure>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Closing CTA --------------------------------------------------- */}
        <section className="wl-close wl-reveal">
          <img className="wl-close-mascot" src="/brand/timo-mascot.svg" alt="" width={84} height={84} aria-hidden="true" />
          <h2 className="wl-display-lg">Go on, start the clock.</h2>
          <p className="wl-sec-lead wl-close-lead">Install it once and forget it exists. That's the whole pitch.</p>
          <div className="wl-ctas wl-close-ctas">
            <a className="wl-btn wl-btn--primary wl-btn--dl" href={dlHref} target="_blank" rel="noreferrer">
              {dlIcon && <img src={dlIcon} alt="" width={17} height={17} />}
              {dlLabel}
            </a>
            <a className="wl-btn wl-btn--secondary" href="/home">Open the dashboard</a>
          </div>
        </section>
      </main>

      {/* ---- Footer --------------------------------------------------------- */}
      <footer className="wl-footer">
        <div className="wl-container wl-footer-grid">
          <p className="wl-footer-wordmark">Timo</p>
          <div className="wl-footer-cols">
            <div className="wl-footer-col">
              <p className="wl-caption">PRODUCT</p>
              <a href="/home">Dashboard</a>
              <a href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">Get Timo</a>
            </div>
            <div className="wl-footer-col">
              <p className="wl-caption">RELEASES</p>
              <a href="/changelog">Changelog</a>
              <a href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">GitHub releases</a>
            </div>
            <div className="wl-footer-col">
              <p className="wl-caption">PRINCIPLES</p>
              <a href="#privacy">The contract</a>
              <a href="/changelog#foundation">Foundation</a>
            </div>
          </div>
        </div>
        <div className="wl-container wl-footer-legal">
          <p className="wl-caption">© 2026 EMIAC · INTERNAL TOOL · COUNTS, NEVER CONTENT</p>
        </div>
      </footer>
    </div>
  );
}

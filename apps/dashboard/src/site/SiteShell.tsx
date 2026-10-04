import './site.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TimoMark, assembleMark } from './TimoMark';
import { DownloadButton, useDownload } from './download';

/**
 * The frame every public page shares: the landing at `/`, the changelog and
 * the privacy policy. Drawn after the Crux landing (EMIAC's product-page
 * pattern): a quiet header with "by EMIAC", a footer whose giant wordmark
 * swipes in from the left when you reach the end of the page, and, each time
 * the landing loads, the mark drawing itself and flying into the header.
 */

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Page = 'home' | 'changelog' | 'privacy';

export function SiteShell({ page, title, intro = false, children }: { page: Page; title: string; intro?: boolean; children: ReactNode }) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
  useReveal();
  // Decided once, in the first render, so the overlay is in the very first
  // paint and the page never flashes before the intro covers it.
  const [showIntro, setShowIntro] = useState(() => intro && !reducedMotion());
  // While the mark draws itself the page's own entrance waits, paused, and
  // starts as the mark takes off for the header.
  const [waiting, setWaiting] = useState(showIntro);

  return (
    <div className={`site${waiting ? ' is-waiting' : ''}`}>
      <SiteHeader page={page} logoHidden={showIntro} />
      <main id="main">{children}</main>
      <SiteFooter />
      {showIntro && <Intro onFly={() => setWaiting(false)} onDone={() => setShowIntro(false)} />}
    </div>
  );
}

/* ---------- Header ---------- */

function SiteHeader({ page, logoHidden }: { page: Page; logoHidden: boolean }) {
  const download = useDownload();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const here = (p: Page) => (p === page ? { 'aria-current': 'page' as const } : {});

  return (
    <header className={`site-nav${scrolled ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`}>
      <a className="site-skip" href="#main">Skip to content</a>
      <div className="site-nav-bar">
        <a className="site-brand" href="/" aria-label="Timo, home">
          <TimoMark size={26} className={logoHidden ? 'is-hidden' : ''} />
          <span>Timo</span>
        </a>
        <a className="site-by" href="https://emiac.us/" aria-label="Made by EMIAC">
          <span>by</span>
          <img src="/brand/emiac-mark.svg" alt="" width={11} height={16} />
          EMIAC
        </a>
        <nav className="site-menu" aria-label="Main">
          <a href="/#how">How it works</a>
          <a href="/changelog" {...here('changelog')}>Changelog</a>
          <a href="/privacy" {...here('privacy')}>Privacy</a>
        </nav>
        <div className="site-nav-actions">
          <SignIn />
          <DownloadButton link={download} />
          <button
            className="site-burger"
            type="button"
            aria-expanded={open}
            aria-controls="site-mobile"
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
          >
            <span /><span />
          </button>
        </div>
      </div>
      <div className="site-mobile" id="site-mobile" hidden={!open}>
        <a href="/#how" onClick={() => setOpen(false)}>How it works</a>
        <a href="/changelog">Changelog</a>
        <a href="/privacy">Privacy policy</a>
        <a className="site-btn site-btn--quiet" href="/login">Sign in</a>
        <DownloadButton link={download} size="lg" />
      </div>
    </header>
  );
}

/** Sign in turns busy, and the app's own sign-in picks up from there. */
function SignIn() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Back from the app restores this page from cache, busy; put the label back.
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  return (
    <a
      className={`site-btn site-btn--quiet site-signin${busy ? ' is-busy' : ''}`}
      href="/login"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        setBusy(true);
      }}
    >
      {busy && <TimoLoader size={14} />}
      Sign in
    </a>
  );
}

/* ---------- Loader ---------- */

/**
 * The waiting mark: the bar writes, the stem drops, now pops in, and the
 * whole thing lets go and starts again, 1.8s a turn. For anything on the
 * public pages that is on its way (a film, the hand-over to sign in).
 */
export function TimoLoader({ size, label }: { size: number; label?: string }) {
  return (
    <span className="timo-loader" role={label ? 'status' : undefined}>
      <TimoMark size={size} className="timo-mark--loop" />
      {label && <span className="timo-loader-label">{label}</span>}
    </span>
  );
}

/* ---------- Intro ---------- */

/** On load: the mark draws itself, then flies into the header's logo. */
function Intro({ onFly, onDone }: { onFly: () => void; onDone: () => void }) {
  const veil = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const fly = useRef(onFly);
  fly.current = onFly;

  useLayoutEffect(() => {
    const root = veil.current;
    const box = holder.current;
    const mark = box?.querySelector('svg');
    const logo = document.querySelector('.site-brand .timo-mark');
    if (!root || !box || !mark || !logo) { fly.current(); done.current(); return; }
    let cancelled = false;
    void assembleMark(mark, 120).then(() => {
      if (cancelled) return;
      const first = box.getBoundingClientRect();
      const last = logo.getBoundingClientRect();
      const travel = `translate(${last.left - first.left}px, ${last.top - first.top}px) scale(${last.width / first.width})`;
      box.animate([{ transform: 'none' }, { transform: travel }], { duration: 760, delay: 140, easing: EASE, fill: 'both' });
      window.setTimeout(() => { if (!cancelled) fly.current(); }, 240);
      root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 560, delay: 360, easing: EASE, fill: 'both' })
        .finished.then(() => { if (!cancelled) done.current(); }, () => undefined);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="site-intro" aria-hidden="true">
      <div className="site-intro-veil" ref={veil} />
      <div className="site-intro-mark" ref={holder}>
        <TimoMark size={112} />
      </div>
    </div>
  );
}

/* ---------- Footer ---------- */

/** EMIAC's own channels, drawn as the Crux footer draws them. */
const SOCIAL: Array<[string, string, ReactNode]> = [
  ['LinkedIn', 'https://www.linkedin.com/company/emiactech/', <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.94 5a2 2 0 1 1-4-.002 2 2 0 0 1 4 .002zM7 8.48H3V21h4zm6.32 0H9.34V21h3.94v-6.57c0-3.66 4.77-4 4.77 0V21H22v-7.93c0-6.17-7.06-5.94-8.72-2.91z" /></svg>],
  ['Instagram', 'https://www.instagram.com/emiactech/', <svg className="is-line" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle className="dot" cx="17.3" cy="6.7" r="1.1" /></svg>],
  ['Facebook', 'https://www.facebook.com/EMIACTech', <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 13.5h2.5l1-4H14v-2c0-1.03 0-2 2-2h1.5V2.14c-.326-.043-1.557-.14-2.857-.14C11.928 2 10 3.657 10 6.7v2.8H7v4h3V22h4z" /></svg>],
  ['X', 'https://x.com/emiactech', <svg viewBox="-3 -3 30 30" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" /></svg>],
  ['Upwork', 'https://www.upwork.com/ag/emiactechnologies/', <svg viewBox="-2.5 -2.5 29 29" aria-hidden="true"><path d="M18.561 13.158c-1.102 0-2.135-.467-3.074-1.227l.228-1.076.008-.042c.207-1.143.849-3.06 2.839-3.06 1.492 0 2.703 1.212 2.703 2.703-.001 1.489-1.212 2.702-2.704 2.702zm0-8.14c-2.539 0-4.51 1.649-5.31 4.366-1.22-1.834-2.148-4.036-2.687-5.892H7.828v7.112c-.002 1.406-1.141 2.546-2.547 2.548-1.405-.002-2.543-1.143-2.545-2.548V3.492H0v7.112c0 2.914 2.37 5.303 5.281 5.303 2.913 0 5.283-2.389 5.283-5.303v-1.19c.529 1.107 1.182 2.229 1.974 3.221l-1.673 7.873h2.797l1.213-5.71c1.063.679 2.285 1.109 3.686 1.109 3 0 5.439-2.452 5.439-5.45 0-3-2.439-5.439-5.439-5.439z" /></svg>],
  ['WhatsApp', 'https://wa.me/16503922238', <svg viewBox="-2.5 -2.5 29 29" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" /></svg>],
];

function SiteFooter() {
  const download = useDownload();
  const sign = useRef<HTMLDivElement>(null);

  // The end of the page: the mark draws itself, then "Timo" swipes out from
  // behind it, left to right. The same beat that closes every Timo film.
  useEffect(() => {
    const root = sign.current;
    if (!root) return;
    if (reducedMotion()) { root.classList.add('is-in'); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const mark = root.querySelector<SVGSVGElement>('svg');
      const word = root.querySelector<HTMLElement>('.site-sign-word');
      const inner = root.querySelector<HTMLElement>('.site-sign-word span');
      if (!mark || !word || !inner) return;
      // The mark starts centred, where the whole sign's middle will be.
      const shift = (word.offsetWidth + parseFloat(getComputedStyle(root).columnGap || '0')) / 2;
      root.classList.add('is-in');
      // One timeline, set up at once so nothing shows early: the mark draws
      // itself at the centre (about 1s), then slides to its place as the word
      // slides out from behind it.
      const SWIPE = 1100;
      void assembleMark(mark);
      mark.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 820, delay: SWIPE, easing: EASE, fill: 'backwards' });
      inner.animate([{ transform: 'translateX(-104%)' }, { transform: 'none' }], { duration: 820, delay: SWIPE, easing: EASE, fill: 'backwards' });
    }, { threshold: 0.45 });
    io.observe(root);
    return () => io.disconnect();
  }, []);

  return (
    <footer className="site-foot">
      <div className="site-foot-inner">
        <div className="site-foot-brand">
          <a className="site-brand site-brand--lg" href="/" aria-label="Timo, home">
            <TimoMark size={34} /><span>Timo</span>
          </a>
          <p className="site-foot-line">
            Time tracking that counts, never reads. Made by <a href="https://emiac.us/">EMIAC</a>.
          </p>
          <p className="site-foot-find">Find EMIAC at</p>
          <p className="site-foot-social">
            {SOCIAL.map(([label, href, icon]) => (
              <a key={label} href={href} aria-label={`EMIAC on ${label}`}>{icon}</a>
            ))}
          </p>
          <p className="site-foot-legal">
            © 2026 <b>EMIAC INC.</b> <span className="site-nowrap">All rights reserved.</span><br />
            <a href="/privacy">Privacy policy</a>
          </p>
        </div>
        <nav className="site-foot-cols" aria-label="Footer">
          <div>
            <p>Timo</p>
            <a href="/#how">How it works</a>
            <a href="/#day">Your day</a>
            <a href="/#team">The dashboard</a>
            <a href="/#contract">The contract</a>
            <a href="/#faq">Questions</a>
          </div>
          <div>
            <p>Get started</p>
            <a href={download.href}>{download.label}</a>
            <a href="mailto:inc@emiac.us?subject=Timo">Contact us</a>
            <a href="/login">Sign in</a>
            <a href="/changelog">Changelog</a>
            <a href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">GitHub releases</a>
          </div>
          <div>
            <p>EMIAC</p>
            <a href="https://emiac.us/">emiac.us</a>
            <a href="https://www.linkedin.com/company/emiactech/">EMIAC on LinkedIn</a>
            <a href="https://clario.emiactech.com/">Clario</a>
          </div>
        </nav>
      </div>
      <div className="site-sign" ref={sign} aria-hidden="true">
        <TimoMark size={0} className="site-sign-mark" />
        <span className="site-sign-word"><span>Timo</span></span>
      </div>
    </footer>
  );
}

/* ---------- Reveal ---------- */

/** Anything marked `.reveal` rises in once, the first time it is on screen. */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal');
    if (reducedMotion()) { els.forEach((el) => el.classList.add('is-in')); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

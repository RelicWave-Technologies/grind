import './landing.css';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SiteShell } from './SiteShell';
import { TimoMark } from './TimoMark';
import { Film } from './Film';
import { DownloadButton, useDownload } from './download';
import { AUGUST, LATEST } from './releases';

/**
 * The public landing page at `/` (and `/welcome`). Built to the Crux
 * landing's standard — EMIAC's product-page pattern: a hero with the film
 * that tells the whole story, then numbered sections, each with its own film
 * or a live piece, the contract, questions, and a blue band to end on.
 *
 * Every claim here is true of the code today (checked 2026-10-04): there is
 * no screenshot blur or self-delete, so the page promises neither.
 */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LandingScreen() {
  const download = useDownload();
  return (
    <SiteShell page="home" title="Timo · Time tracking your team won't resent" intro>
      <Hero />

      <section className="lp-sec" id="why">
        <div className="site-wrap lp-split">
          <SectionHead n="01" kicker="Why it matters" title={<>Hours you can<br />stand behind.</>}>
            <p>A Friday timesheet is a guess. Timo writes the day as it happens.</p>
          </SectionHead>
          <LiveDay />
        </div>
        <Moments />
      </section>

      <section className="lp-sec" id="how">
        <div className="site-wrap">
          <SectionHead n="02" kicker="How it works" title={<>Install it once.<br />Then forget it exists.</>} wide />
          <div className="lp-steps">
            <Step icon="play" title="Press play on a task" items={['Your Lark tasks, already there', 'One click to start, one to stop', 'Switch tasks without stopping the clock']}>
              Your Lark tasks are already there. Pick one, press play.
            </Step>
            <Step icon="shield" title="It keeps counting through anything" items={['Written to disk every tick', 'Offline time synced when you are back', 'Asks before counting after a nap']}>
              Crash, dead Wi-Fi, closed lid. Not a minute lost.
            </Step>
            <Step icon="clock" title="Away? It notices." items={['Idle time trimmed, never counted', 'A gentle "still working?" if your team uses one', 'Tracking never stops silently']}>
              Idle time comes off on its own. If Timo stops, it tells you.
            </Step>
          </div>
          <div className="lp-stage reveal">
            <Film name="desktop" alt="The Timo desktop app: a task is started, the floating bar appears, and the day fills in." />
          </div>
        </div>
      </section>

      <section className="lp-sec" id="day">
        <div className="site-wrap lp-feature">
          <SectionHead n="03" kicker="Your day" title={<>Your day,<br />minute by minute.</>}>
            <p>Work, meetings and gaps, on one ribbon.</p>
            <Checks items={['Work, meetings and idle, each in its own colour', 'Gaps outside your shift shown, never filled in', 'Approved manual time marked as manual, so nobody has to ask']} />
          </SectionHead>
          <div className="lp-stage lp-stage--wide reveal">
            <Film name="day" alt="Edit time in the Timo dashboard: the day ribbon, a gap opened and filled with a manual-time request." />
          </div>
        </div>
      </section>

      <section className="lp-sec" id="approvals">
        <div className="site-wrap lp-feature lp-feature--flip">
          <SectionHead n="04" kicker="Manual time" title={<>Forgot to start?<br />Ask once.</>}>
            <p>Pick the gap, say what it was. Your manager approves it in Lark.</p>
            <Checks items={['Approve or reject from a Lark card', 'Every request kept with its reason', 'Pending and rejected time never counts']} />
          </SectionHead>
          <div className="lp-stage reveal">
            <LarkCard />
          </div>
        </div>
      </section>

      <section className="lp-sec" id="team">
        <div className="site-wrap">
          <SectionHead n="05" kicker="The dashboard" title={<>The other half lives<br />in your browser.</>} wide>
            <p>Managers see the team. Everyone sees their own day.</p>
          </SectionHead>
          <div className="lp-stage lp-stage--full reveal">
            <Film
              name="team"
              alt="The Timo dashboard for a manager: the team today, attendance, approvals and the weekly report."
              chapters={[
                // Plate marks of scripts/films/compose/team.html, plus its 134-frame opener.
                { label: 'The team, today', at: 0 },
                { label: 'Who is in', at: 10 },
                { label: 'Waiting on you', at: 16.2 },
                { label: 'The week, honestly', at: 23.1 },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="lp-sec" id="contract">
        <div className="site-wrap">
          <div className="lp-contract">
            <div className="lp-contract-lead reveal">
              <TimoMark size={36} onDark />
              <div>
                <p className="lp-contract-kicker">06 · The contract</p>
                <h2>Counts, never content.</h2>
                <p>Timo counts that you typed. Never what.</p>
                <a className="lp-contract-link" href="/privacy">Read the privacy policy</a>
              </div>
            </div>
            <ContractCard tone="sky" kicker="keys · clicks · scroll" title="Counted, not read">
              How many, per minute. Never which keys.
            </ContractCard>
            <ContractCard tone="lilac" kicker="every 3 minutes, by default" title="Screenshots, in daylight">
              You see yours. Gone after 60 days.
            </ContractCard>
            <ContractCard tone="teal" kicker="off unless your admin turns them on" title="Apps, titles, URLs">
              Off unless your admin turns them on.
            </ContractCard>
            <ContractCard tone="deep" kicker="no microphone · no camera · no clipboard" title="Never silent">
              If Timo stops counting, it says so.
            </ContractCard>
          </div>
        </div>
      </section>

      <section className="lp-sec" id="engineering">
        <div className="site-wrap lp-split lp-split--flip">
          <SectionHead n="07" kicker="The engineering" title={<>Zero-loss<br />timekeeping.</>}>
            <p>Every tick hits the disk first. The server counts only what it can prove.</p>
            <Checks items={['A stopwatch, not the wall clock: a wrong clock cannot bend it', 'Offline minutes kept on the laptop until they are confirmed', 'A new install picks up the confirmed day where it left off']} />
          </SectionHead>
          <SyncLog />
        </div>
      </section>

      <section className="lp-sec" id="roles">
        <div className="site-wrap">
          <SectionHead n="08" kicker="Who it is for" title={<>Three roles,<br />one honest record.</>} wide />
          <div className="lp-roles">
            <Role icon="person" title="Members">Your time, your day, your screenshots.</Role>
            <Role icon="team" title="Managers">Your team: who is in, what waits on you.</Role>
            <Role icon="key" title="Admins">People, shifts, policy, payroll.</Role>
            <Role icon="lark" title="Lark">Sign-in, tasks and approvals, in chat.</Role>
          </div>
        </div>
      </section>

      <section className="lp-sec" id="releases">
        <div className="site-wrap lp-split">
          <SectionHead n="09" kicker="The cadence" title={<>Small releases,<br />every few days.</>}>
            <p>Timo updates itself. Every release is written up.</p>
            <a className="site-btn site-btn--quiet" href="/changelog">Read the changelog</a>
          </SectionHead>
          <ol className="lp-releases reveal">
            {[LATEST, ...AUGUST].slice(0, 3).map((r) => (
              <li key={r.id}>
                <a href={`/changelog#${r.id}`}>
                  <span className="lp-release-v">{r.version}</span>
                  <span className="lp-release-name">{r.name.charAt(0).toUpperCase() + r.name.slice(1)}</span>
                  <span className="lp-release-meta">{r.meta.split(' · ')[0]?.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-sec" id="faq">
        <div className="site-wrap lp-faq">
          <h2 className="lp-faq-title reveal">Questions</h2>
          <Faq />
        </div>
      </section>

      <section className="lp-sec lp-sec--band" id="start">
        <div className="site-wrap">
          <div className="lp-band reveal">
            <TimoMark size={48} onDark />
            <h2>Go on, start the clock.</h2>
            <p>Install it once and forget it exists. That's the whole pitch.</p>
            <div className="lp-actions">
              <DownloadButton link={download} size="lg" tone="light" />
              <a className="site-btn site-btn--ghost site-btn--lg" href="/login">Open the dashboard</a>
            </div>
            <p className="lp-band-fine">Mac and Windows · Signed and notarised on Mac</p>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

/* ---------- Hero ---------- */

function Hero() {
  const download = useDownload();
  return (
    <>
      <section className="lp-hero" id="top">
        <a className="lp-pill rise" href={`/changelog#${LATEST.id}`}>
          <em>New</em>
          {LATEST.version}
          <span>{LATEST.name.charAt(0).toUpperCase() + LATEST.name.slice(1)}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11l6-6M6 5h5v5" /></svg>
        </a>
        <h1 className="rise">
          Timo <span className="lp-ribbon">keeps time.</span>
          <br />
          You keep shipping.
        </h1>
        <p className="lp-lede rise">
          Real hours, honest screenshots, approvals in Lark. No opinions about your lunch break.
        </p>
        <div className="lp-actions rise">
          <DownloadButton link={download} size="lg" />
          <a className="site-btn site-btn--quiet site-btn--lg" href="#how">See how it works</a>
        </div>
        <Ticker />
        <p className="lp-fine rise">Mac and Windows · Lark sign-in and approvals · An EMIAC product</p>
      </section>

      <div className="site-wrap lp-hero-film rise">
        <Film
          hero
          name="hero"
          alt="The Timo film: a task started on the desktop, the day filling in, a forgotten hour approved in Lark, and the team's week in the dashboard."
          chapters={[
            // Cut points of scripts/films/compose/hero.html (frame / 30).
            { label: 'Press play', at: 0 },
            { label: 'The day fills in', at: 7.6 },
            { label: 'Forgot to start?', at: 11.4 },
            { label: 'The team, today', at: 19.5 },
            { label: 'The week, honestly', at: 23.5 },
          ]}
        />
      </div>
    </>
  );
}

/** The hero's line: a timer that is actually running, the way the menu bar shows it. */
function Ticker() {
  const start = useRef(Date.now() - (2 * 3600 + 41 * 60 + 7) * 1000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.floor((now - start.current) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (
    <p className="lp-ticker rise" role="timer" aria-label="A Timo timer running">
      <span className="lp-ticker-dot" aria-hidden="true" />
      Tracking
      <span className="lp-ticker-task">Homepage redesign</span>
      <span className="lp-ticker-time">{hh}:{mm}<span>:{ss}</span></span>
    </p>
  );
}

/* ---------- Section parts ---------- */

function SectionHead({ n, kicker, title, wide = false, children }: { n: string; kicker: string; title: ReactNode; wide?: boolean; children?: ReactNode }) {
  return (
    <div className={`lp-head reveal${wide ? ' lp-head--wide' : ''}`}>
      <p className="lp-kicker"><span>{n}</span>{kicker}</p>
      <h2>{title}</h2>
      {children && <div className="lp-head-body">{children}</div>}
    </div>
  );
}

function Checks({ items }: { items: string[] }) {
  return (
    <ul className="lp-checks">
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  );
}

const ICONS: Record<string, ReactNode> = {
  play: <path d="M7 5.5v13l11-6.5z" />,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6zM9 12l2 2 4-4" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  person: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  team: <><circle cx="9" cy="8.5" r="3" /><circle cx="17" cy="9.5" r="2.4" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 14.4c2.3.1 4 1.6 4.6 4.1" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2" /></>,
  lark: <path d="M4 13.5l6.5-3 9.5-6.5-4 13-4.5-3.5L8 18v-5z" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>
  );
}

function Step({ icon, title, items, children }: { icon: string; title: string; items: string[]; children: ReactNode }) {
  return (
    <article className="lp-step reveal">
      <Icon name={icon} />
      <h3>{title}</h3>
      <p>{children}</p>
      <Checks items={items} />
    </article>
  );
}

function Role({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <article className="lp-role reveal">
      <Icon name={icon} />
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function ContractCard({ tone, kicker, title, children }: { tone: 'sky' | 'lilac' | 'teal' | 'deep'; kicker: string; title: string; children: ReactNode }) {
  return (
    <article className={`lp-card lp-card--${tone} reveal`}>
      <p className="lp-card-kicker">{kicker}</p>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

/* ---------- 01: the day, filling in ---------- */

type Kind = 'work' | 'meeting' | 'idle' | 'manual';
// A made-up day, 9:00 to 18:00 in minutes from 9:00.
const DAY: Array<{ kind: Kind; from: number; to: number }> = [
  { kind: 'work', from: 4, to: 98 },
  { kind: 'meeting', from: 98, to: 140 },
  { kind: 'work', from: 140, to: 212 },
  { kind: 'idle', from: 212, to: 262 },
  { kind: 'work', from: 262, to: 340 },
  { kind: 'manual', from: 340, to: 372 },
  { kind: 'work', from: 372, to: 470 },
  { kind: 'meeting', from: 470, to: 500 },
  { kind: 'work', from: 500, to: 532 },
];
const SPAN = 540;
const FILL_MS = 6000;

function fmt(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function LiveDay() {
  const root = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0); // minutes of the day drawn so far

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (reducedMotion()) { setT(SPAN); return; }
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / FILL_MS);
      const eased = 1 - Math.pow(1 - p, 2.2);
      setT(eased * SPAN);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { io.disconnect(); raf = requestAnimationFrame(tick); }
    }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const sum = (k: Kind) => DAY.filter((s) => s.kind === k).reduce((a, s) => a + Math.max(0, Math.min(t, s.to) - s.from), 0);
  const worked = sum('work') + sum('manual');
  const nowPct = (t / SPAN) * 100;

  return (
    <div className="lp-live reveal" ref={root}>
      <div className="lp-live-bar">
        <span className="lp-dots" aria-hidden="true"><i /><i /><i /></span>
        Today · Meera Iyer
      </div>
      <div className="lp-live-body">
        <p className="lp-live-label">Tracked today</p>
        <p className="lp-live-figure">{fmt(worked)}</p>
        <div className="lp-live-ribbon" aria-hidden="true">
          {DAY.map((s, i) => {
            const shown = Math.max(0, Math.min(t, s.to) - s.from);
            if (shown <= 0) return null;
            return (
              <span
                key={i}
                className={`lp-seg lp-seg--${s.kind}`}
                style={{ left: `${(s.from / SPAN) * 100}%`, width: `${(shown / SPAN) * 100}%` }}
              />
            );
          })}
          {t < SPAN && <span className="lp-now" style={{ left: `${nowPct}%` }} />}
        </div>
        <div className="lp-live-axis" aria-hidden="true">
          <span>9 AM</span><span>12 PM</span><span>3 PM</span><span>6 PM</span>
        </div>
        <dl className="lp-live-stats">
          <div><dt><i className="lp-key lp-key--work" />Work</dt><dd>{fmt(sum('work'))}</dd></div>
          <div><dt><i className="lp-key lp-key--meeting" />Meetings</dt><dd>{fmt(sum('meeting'))}</dd></div>
          <div><dt><i className="lp-key lp-key--manual" />Manual, approved</dt><dd>{fmt(sum('manual'))}</dd></div>
          <div><dt><i className="lp-key lp-key--idle" />Idle, not counted</dt><dd>{fmt(sum('idle'))}</dd></div>
        </dl>
      </div>
    </div>
  );
}

/* ---------- 01: moments, drifting ---------- */

const MOMENTS: Array<[string, string]> = [
  ['Laptop slept at 1:12 PM', 'Minutes before it kept'],
  ['Wi-Fi dropped for 9 minutes', 'Nothing lost, synced on return'],
  ['Away 14 minutes', 'Trimmed, never counted'],
  ['Forgot to start at 10:00', 'Asked once, approved in Lark'],
  ['Clock changed by the system', 'The stopwatch did not notice'],
  ['Lunch, timer still on', 'Asked before it counted'],
  ['New laptop on Monday', 'Confirmed day came back'],
  ['Screen Recording switched off', 'Paused and said so'],
];

function Moments() {
  const row = (key: string) => (
    <div className="lp-moments-run" aria-hidden={key === 'b'}>
      {MOMENTS.map(([what, then]) => (
        <span className="lp-moment" key={what}>
          <span className="lp-moment-what">{what}</span>
          <span className="lp-moment-then">{then}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="lp-moments reveal">
      <p className="lp-moments-title">Days like these, kept honestly</p>
      <div className="lp-moments-track">
        {row('a')}
        {row('b')}
      </div>
    </div>
  );
}

/* ---------- 04: the Lark card ---------- */

function LarkCard() {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'pending' | 'approved'>('pending');
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (reducedMotion()) { setState('approved'); return; }
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      window.clearTimeout(timer);
      if (e?.isIntersecting) timer = window.setTimeout(() => setState('approved'), 2200);
      else setState('pending');
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); };
  }, []);
  return (
    <div className="lp-lark" ref={root}>
      <div className="lp-lark-chat">
        <div className="lp-lark-head">
          <span className="lp-lark-bot"><TimoMark size={18} onDark /></span>
          <span>Timo</span>
          <span className="lp-lark-tag">Bot</span>
          <span className="lp-lark-time">10:42</span>
        </div>
        <div className={`lp-lark-card is-${state}`}>
          <p className="lp-lark-title">Manual time request</p>
          <dl>
            <div><dt>From</dt><dd>Meera Iyer</dd></div>
            <div><dt>When</dt><dd>Today, 9:05 – 10:00 AM</dd></div>
            <div><dt>Task</dt><dd>Homepage redesign</dd></div>
            <div><dt>Reason</dt><dd>Started on the client call, forgot to press play.</dd></div>
          </dl>
          <div className="lp-lark-actions">
            {state === 'pending' ? (
              <>
                <span className="lp-lark-btn lp-lark-btn--yes">Approve</span>
                <span className="lp-lark-btn">Reject</span>
              </>
            ) : (
              <span className="lp-lark-done">Approved by Arjun Rao · 55m added to today</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 07: the sync log ---------- */

const LOG: Array<{ at: string; text: string; tone?: 'good' | 'wait' | 'bad' }> = [
  { at: '14:02:00', text: 'tick written to disk' },
  { at: '14:02:30', text: 'sent · server confirmed 30s', tone: 'good' },
  { at: '14:03:10', text: 'network lost · minutes kept on this laptop', tone: 'wait' },
  { at: '14:11:40', text: 'still counting · 8m 30s waiting to send', tone: 'wait' },
  { at: '14:12:05', text: 'back online · 9m 25s sent', tone: 'good' },
  { at: '14:12:06', text: 'server confirmed · nothing lost', tone: 'good' },
  { at: '14:30:00', text: 'system clock moved 6 minutes · stopwatch unchanged' },
  { at: '14:44:12', text: 'away 14 minutes · trimmed, not counted', tone: 'bad' },
];

function SyncLog() {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (reducedMotion()) { setShown(LOG.length); return; }
    let timer = 0;
    const step = (n: number) => {
      setShown(n);
      timer = window.setTimeout(() => step(n >= LOG.length ? 1 : n + 1), n >= LOG.length ? 3200 : 900);
    };
    const io = new IntersectionObserver(([e]) => {
      window.clearTimeout(timer);
      if (e?.isIntersecting) step(1);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); };
  }, []);
  return (
    <div className="lp-log reveal" ref={root}>
      <div className="lp-live-bar lp-live-bar--dark">
        <span className="lp-dots" aria-hidden="true"><i /><i /><i /></span>
        Timo · this afternoon
      </div>
      <ol className="lp-log-lines" aria-label="An example afternoon in Timo's own log">
        {LOG.slice(0, shown).map((l) => (
          <li key={l.at} className={l.tone ? `is-${l.tone}` : undefined}>
            <time>{l.at}</time>
            <span>{l.text}</span>
          </li>
        ))}
        <li className="lp-log-cursor" aria-hidden="true"><time /><span /></li>
      </ol>
    </div>
  );
}

/* ---------- FAQ ---------- */

const FAQ: Array<[string, ReactNode]> = [
  ['What is Timo?', <>A time tracker for EMIAC's teams: a desktop app on Mac and Windows that counts your working time, and a dashboard in the browser where you see your day and managers see their team's.</>],
  ['What does Timo record?', <>Your working time, split into work, meetings and idle; how many keys, clicks and scrolls happen in each minute (never which ones); and screenshots on a set cadence, every three minutes unless your admin picks one or two. Apps, window titles and page addresses are only recorded if an admin turns them on. The <a href="/privacy">privacy policy</a> has the whole list.</>],
  ['Who can see my screenshots?', <>You can see your own. Your manager can see their team's, and admins can see the workspace's. They are deleted after 60 days unless your workspace sets a different period.</>],
  ['I forgot to start the timer. Now what?', <>Open Edit time, pick the gap, say what you were doing and send it. Your manager approves it in Lark or the dashboard. It counts once approved; until then it doesn't.</>],
  ['What happens if my laptop crashes or goes offline?', <>Nothing is lost. Every tick is written to disk first, offline time is kept on the laptop and sent when you are back, and after sleep Timo asks before it counts the time you were away.</>],
  ['Does it work on Windows?', <>Yes. Timo runs on Mac and Windows. The Mac app is signed and notarised by Apple; the Windows installer is unsigned for now and installed by our IT team.</>],
  ['How do updates work?', <>Timo updates itself. It checks after launch and when you open Settings, and installs when you restart it. Every release is written up in the <a href="/changelog">changelog</a>.</>],
  ['Can I use Timo for my own company?', <>Timo is built by EMIAC for EMIAC's own teams. If you would like something like it, <a href="https://emiac.us/">talk to EMIAC</a>.</>],
];

function Faq() {
  return (
    <div className="lp-faq-list reveal">
      {FAQ.map(([q, a]) => (
        <details key={q}>
          <summary>{q}<span aria-hidden="true" /></summary>
          <p>{a}</p>
        </details>
      ))}
    </div>
  );
}

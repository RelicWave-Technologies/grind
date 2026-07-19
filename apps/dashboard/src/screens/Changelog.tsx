import './changelog.css';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * /changelog — public editorial release history (no auth, no app shell).
 * Built strictly to DESIGN.md (the Figma marketing analysis): monochrome
 * chrome (white canvas, black ink, pill CTAs, mono taxonomy) interrupted by
 * full-width pastel color-block sections — lime for the latest build, navy
 * for the platform story, coral for shipping mechanics, a lilac banner for
 * the privacy contract. Content is static by design: the changelog ships
 * with the build it describes. Motion is CSS-first and honors
 * prefers-reduced-motion. The animated release cards are drawn from scratch
 * by .context/create_timo_release_cards.py.
 */

type Tag = 'new' | 'improved' | 'fixed' | 'internal';

const TAG_LABEL: Record<Tag, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  internal: 'Internal',
};

interface Change {
  tag: Tag;
  text: ReactNode;
}

interface Release {
  id: string;
  version: string;
  name: string;
  meta: string;
  lead?: ReactNode;
  changes: Change[];
  extra?: ReactNode;
}

function Card({ src, alt, w, h }: { src: string; alt: string; w: number; h: number }) {
  return (
    <figure className="cl-artifact">
      <img src={src} alt={alt} loading="lazy" width={w} height={h} />
    </figure>
  );
}

const LATEST: Release = {
  id: 'beta-28',
  version: 'beta.28',
  name: 'the reliability update',
  meta: 'JUL 17, 2026 · MAC + WINDOWS',
  changes: [
    { tag: 'improved', text: <>macOS permission recovery got serious. If Screen Recording access vanishes mid-day, Timo pauses, tells you, and waits for you to say go. No counting in the dark.</> },
    { tag: 'improved', text: <>The popups formed an orderly queue. Idle, welcome-back and permission prompts now share one calm window and take turns — no stacking, no duplicates, and an outdated prompt can't touch your timer.</> },
    { tag: 'new', text: <>Approved manual time shows up in Today. Desktop and dashboard finally tell the same story about your day.</> },
    { tag: 'fixed', text: <>Windows launch-at-login is now checked against what Windows will actually do — not what it promised.</> },
  ],
};

const JULY: Release[] = [
  {
    id: 'beta-27',
    version: 'beta.27',
    name: 'the zero-loss update',
    meta: 'JUL 16, 2026 · MAC + WINDOWS',
    lead: (
      <>The big one. We rebuilt how tracked time survives crashes, dead Wi-Fi, reinstalls and timezones. House rule: <strong>software may not lose a minute you actually worked.</strong></>
    ),
    changes: [
      { tag: 'new', text: <>Timer protocol v2. Every timer move is written to disk before it hits your screen, and the server won't count hours nobody can prove. Stale clients can no longer invent overtime. Sorry.</> },
      { tag: 'new', text: <>Today Ledger hydration. New laptop? Fresh install? Your confirmed day walks right back in — without stepping on anything you did offline. Rolling out per user: off → shadow → visible.</> },
      { tag: 'new', text: <>One clock for the whole workspace. Business days follow the workspace timezone everywhere — desktop, dashboard, Lark, payroll. Your laptop can believe it's in Narnia; payroll won't.</> },
      { tag: 'new', text: <>Launch-at-login can inspect and repair itself, and macOS finally gets a proper Move-to-Applications flow.</> },
      { tag: 'improved', text: <>The floating bar became a real remote: pause and resume right there. Closing it closes the bar — not your timer.</> },
      { tag: 'improved', text: <>Lark sign-in returns you to the app instead of abandoning you in a browser tab.</> },
      { tag: 'fixed', text: <>Windows logouts, gone. One token writer, one refresh path. The “why am I signed out <em>again</em>” era is officially over.</> },
      { tag: 'internal', text: <>A strict macOS permission gate before any capture starts, and less code in the hot paths.</> },
    ],
    extra: <Card src="/brand/timo-card-beta27.gif?v=3" alt="Animated scene: minute tiles drop into a ledger while Timo supervises — every minute accounted for" w={560} h={200} />,
  },
  {
    id: 'beta-26',
    version: 'beta.26',
    name: 'the one we never shipped',
    meta: 'JUL 12, 2026 · LAB ONLY',
    changes: [
      { tag: 'internal', text: <>A notarized macOS candidate that lived a full life in the lab and retired undefeated. Auto-update can't tell two builds with the same number apart, so once a number touches any machine, it's spent. beta.26 taught us that rule; beta.27 shipped its homework.</> },
    ],
  },
  {
    id: 'beta-25',
    version: 'beta.25',
    name: 'Windows, un-blanked',
    meta: 'JUL 8, 2026 · HOTFIX, FIVE HOURS AFTER BETA.24',
    changes: [
      { tag: 'fixed', text: <>The Windows blank-window-on-startup special that beta.24 introduced. Five hours from “why is my screen empty” to fixed.</> },
      { tag: 'improved', text: <>The tray popover now respects the taskbar instead of hiding behind it.</> },
      { tag: 'improved', text: <>Old app folders migrate forward cleanly. Nothing gets left behind.</> },
    ],
  },
  {
    id: 'beta-24',
    version: 'beta.24',
    name: 'Timo got self-update',
    meta: 'JUL 8, 2026 · MAC + WINDOWS',
    lead: <>The release that installed itself — the first one delivered entirely by the update pipeline June spent a whole afternoon rehearsing.</>,
    changes: [
      { tag: 'new', text: <>Device health you can see. A laptop that stops checking in becomes an IT ticket, not a mystery — and not the employee's fault.</> },
      { tag: 'new', text: <>Start tracking straight from the task list. Search, press play, get on with it.</> },
      { tag: 'improved', text: <>The menu-bar icon stays put whether you're tracking or not.</> },
      { tag: 'improved', text: <>Sturdier logins, safer beta updates.</> },
    ],
    extra: <Card src="/brand/timo-card-beta24.gif?v=3" alt="Animated scene: Timo rides the update rail from OLD to NEW and back — the release that installed itself" w={560} h={190} />,
  },
  {
    id: 'beta-23',
    version: 'beta.23',
    name: 'sign in once, stay signed in',
    meta: 'JUL 6, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>Windows Lark login actually completes now — and survives a restart. Accounts stranded by the Grind → Timo rename found their way home on their own.</> },
      { tag: 'fixed', text: <>Activity batches that were too chunky to upload (hello, 413) slimmed down and synced. Stuck history backfilled itself.</> },
      { tag: 'new', text: <>“Welcome back — resume?” after locks and naps. A locked laptop never quietly bills a meeting you weren't in.</> },
      { tag: 'improved', text: <>Steadier idle prompts, a prettier floating bar, and a Lark status that stopped crying wolf on every network blip.</> },
      { tag: 'internal', text: <>beta.22 was burned mid-cycle and never met a laptop. Version numbers are cheap; trust isn't. (You may need to sign in once after this update. Worth it.)</> },
    ],
  },
  {
    id: 'beta-21',
    version: 'beta.21',
    name: 'approvals, approved',
    meta: 'JUL 4, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>Managers can approve their own manual time again — instantly, with the Lark card still sent so the paper trail stays honest.</> },
      { tag: 'improved', text: <>Approval cards render their buttons properly, and the day ribbon got a good comb-through.</> },
      { tag: 'internal', text: <>Dev builds got their own protocol, so dev-Timo and real-Timo stopped fighting over deep links like siblings.</> },
    ],
  },
  {
    id: 'beta-20',
    version: 'beta.20',
    name: 'the deep-link rescue',
    meta: 'JUL 4, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>Lark login on existing installs: the local database migrates <em>before</em> the deep link fires, so the handshake stops dying mid-air.</> },
      { tag: 'fixed', text: <>The sign-in verifier survives a relaunch instead of quietly evaporating.</> },
      { tag: 'new', text: <>The updater flat-out refuses stale and downgrade offers.</> },
    ],
  },
  {
    id: 'beta-18',
    version: 'beta.18 / 19',
    name: 'hello, Timo',
    meta: 'JUL 4, 2026 · LAB ONLY',
    changes: [
      { tag: 'new', text: <>Grind grew up and got a name. Real icons everywhere, cleaner sign-in, and production moved to timo.emiactech.com.</> },
      { tag: 'improved', text: <>Ships beta.17's admin hardening.</> },
      { tag: 'internal', text: <>beta.19 dug the trench that beta.20 shipped through — same day.</> },
    ],
  },
  {
    id: 'beta-13',
    version: 'beta.13 → 17',
    name: 'the quiet stretch',
    meta: 'JUN 25 → JUL 4, 2026 · LAB ONLY',
    changes: [
      { tag: 'internal', text: <>Five builds that never left the building: a rename, a hardening pass, and the rails for July. Zero public artifacts, zero missing numbers.</> },
    ],
  },
];

const JUNE: Release[] = [
  {
    id: 'beta-12',
    version: 'beta.12',
    name: 'Intel Macs welcome',
    meta: 'JUN 24, 2026 · LAB ONLY',
    changes: [
      { tag: 'fixed', text: <>The image library now packs its own native runtime on Intel Macs instead of assuming the machine has one lying around.</> },
    ],
  },
  {
    id: 'beta-11',
    version: 'beta.11',
    name: 'notarized at last',
    meta: 'JUN 24, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'new', text: <>The first fully notarized macOS build, cleared the moment Apple's paperwork was. Gatekeeper now opens Timo like they've been friends for years.</> },
      { tag: 'fixed', text: <>Creating Lark tasks works again.</> },
    ],
  },
  {
    id: 'beta-5',
    version: 'beta.5 → 10',
    name: 'the updater marathon',
    meta: 'JUN 23, 2026 · ONE AFTERNOON, SIX BUILDS',
    lead: <>Self-update has to work before anything else matters — a broken updater strands every machine it touches. So we tested it the only honest way: by actually updating, hop after hop, all afternoon.</>,
    changes: [],
    extra: (
      <table className="cl-table">
        <thead>
          <tr><th>Build</th><th>What it did</th></tr>
        </thead>
        <tbody>
          <tr><td>beta.5</td><td>Settings stopped claiming updates were off before the updater had even woken up. The service now starts the moment the window does.</td></tr>
          <tr><td>beta.6</td><td>Existed so beta.5 had something to update to. Fulfilled its purpose.</td></tr>
          <tr><td>beta.7</td><td>Another lap around the update loop, just to be sure.</td></tr>
          <tr><td>beta.8</td><td>Timo now checks for updates right after launch — and quietly whenever you open Settings or About.</td></tr>
          <tr><td>beta.9</td><td>Proof that beta.8's automatic checks actually check.</td></tr>
          <tr><td>beta.10</td><td>Victory lap on signed Mac ZIPs and Windows installers.</td></tr>
        </tbody>
      </table>
    ),
  },
  {
    id: 'beta-3',
    version: 'beta.3 / 4',
    name: 'restart to update, fixed',
    meta: 'JUN 23, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>“Restart to update” shows a real restarting state, retries the installer, and bows out gracefully when Electron digs in its heels.</> },
      { tag: 'internal', text: <>beta.4 existed to be updated <em>to</em>. Notarization was skipped that day — Apple's paperwork had expired — and the debt was paid in beta.11.</> },
    ],
  },
  {
    id: 'beta-1',
    version: 'beta.1 / 2',
    name: 'first light',
    meta: 'JUN 23, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'new', text: <>The auto-update pipeline is born. beta.1 carried it; beta.2 was the first update it ever delivered. Signed ZIPs on Mac, unsigned installers on Windows, big plans everywhere.</> },
    ],
  },
];

const PLATFORM: Array<{ date: string; text: ReactNode }> = [
  { date: 'JUL 18', text: <>The screenshot carousel stopped gaslighting you. Arrows and keyboard keys now move the photo, timestamp and stats together — never an old frame wearing a new caption.</> },
  { date: 'JUL 16', text: <>The dashboard got fast: team pages answer with summaries first, routes load lazily, JSON travels compressed, assets cache hard. Answers first, details on click.</> },
  { date: 'JUL 15', text: <>The data-safety train reached production — timer lifecycle, runtime health, one canonical timezone. Additive only, backups verified. Not one tracked row rewritten.</> },
  { date: 'JUL 14', text: <>The API learned the new desktop's vocabulary: a permission-paused state, startup health, and device tags on People (admins only).</> },
  { date: 'JUL 13', text: <>One bad activity row can no longer sink a whole batch. Orphans get quarantined with a reason — not a funeral for everyone else's data.</> },
  { date: 'ALWAYS', text: <>The Timo MCP server and the Tester Ops bot keep Lark chat in the loop: approval cards, break summaries with receipts, payroll schedules.</> },
];

const FOUNDATION: Array<[string, ReactNode]> = [
  ['M1 – M3', <>The timer engine, the floating bar, and the idle prompt that trims itself — the “are you still there?” minute never counts.</>],
  ['M4', <>Screenshots that survive fullscreen: jittered timing, sharp quality, perceptual hashes.</>],
  ['M5', <>Activity as counts — keys, clicks, scroll. Never what you typed.</>],
  ['M6', <>Meeting detection from local signals and calendar free/busy.</>],
  ['M7', <>The Lark app. Everyone signs in as themselves.</>],
  ['M8', <>Role-aware scoring, plus an anti-cheat engine that flags for human review. It never convicts on its own.</>],
  ['M9', <>Track time against actual Lark tasks and see it in reports.</>],
  ['M10', <>Manual time approved — or politely rejected — right in Lark chat.</>],
  ['Edit Time', <>The day ribbon: popovers, gap composers, edits that feel instant.</>],
  ['M11', <>The dashboard itself: My Day, team timesheets, heatmaps, attendance, CSV exports, teams, flags.</>],
  ['M20', <>Member reports and clean RBAC — three roles, capability-based, ready for custom ones later.</>],
];

const MARQUEE = [
  'BETA.28 — RELIABILITY',
  'BETA.27 — ZERO LOSS',
  'BETA.26 — UNSHIPPED',
  'BETA.25 — UN-BLANKED',
  'BETA.24 — SELF-UPDATE',
  'BETA.23 — STAY SIGNED IN',
  'BETA.21 — APPROVALS',
  'BETA.20 — DEEP LINKS',
  'BETA.18 — HELLO, TIMO',
  'BETA.11 — NOTARIZED',
  'BETA.8 — AUTO-CHECK',
  'BETA.5 — UPDATER',
  'BETA.1 — FIRST LIGHT',
];

function Chip({ tag }: { tag: Tag }) {
  return <span className={`cl-chip cl-chip--${tag}`}>{TAG_LABEL[tag]}</span>;
}

function ChangeList({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="cl-changes">
      {changes.map((c, i) => (
        <li key={i} className="cl-change">
          <Chip tag={c.tag} />
          <span className="cl-change-text">{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

function ReleaseEntry({ release }: { release: Release }) {
  return (
    <article id={release.id} className="cl-entry cl-reveal">
      <div className="cl-entry-side">
        <h3 className="cl-entry-version">{release.version}</h3>
        <p className="cl-entry-name">{release.name}</p>
        <p className="cl-caption cl-entry-meta">{release.meta}</p>
      </div>
      <div className="cl-entry-body">
        {release.lead && <p className="cl-entry-lead">{release.lead}</p>}
        <ChangeList changes={release.changes} />
        {release.extra}
      </div>
    </article>
  );
}

function MarqueeRun() {
  return (
    <span className="cl-marquee-run" aria-hidden="true">
      {MARQUEE.map((m) => (
        <span key={m} className="cl-marquee-item">{m}</span>
      ))}
    </span>
  );
}

export function ChangelogScreen() {
  // Document title while the page is mounted.
  useEffect(() => {
    const prev = document.title;
    document.title = 'Timo — Changelog';
    return () => { document.title = prev; };
  }, []);

  // Scroll reveal — sections animate in on scroll (DESIGN.md).
  useEffect(() => {
    const els = document.querySelectorAll('.cl-reveal');
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('cl-in');
            reveal.unobserve(e.target);
          }
        }
      },
      { threshold: 0.05 },
    );
    els.forEach((el) => reveal.observe(el));
    return () => reveal.disconnect();
  }, []);

  return (
    <div className="cl-page">
      {/* ---- Top nav (56px white, pill pair right) ------------------------- */}
      <nav className="cl-nav">
        <div className="cl-nav-inner">
          <a className="cl-nav-brand" href="#top">
            <img src="/brand/timo-mascot.svg" alt="" width={30} height={30} />
            <span>Timo</span>
          </a>
          <div className="cl-nav-links">
            <a href="#latest">Latest</a>
            <a href="#july-2026">Releases</a>
            <a href="#platform">Platform</a>
            <a href="#foundation">Foundation</a>
          </div>
          <div className="cl-nav-ctas">
            <a className="cl-btn cl-btn--secondary" href="/home">Open dashboard</a>
            <a className="cl-btn cl-btn--primary" href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">Get Timo</a>
          </div>
        </div>
      </nav>

      {/* ---- White hero ---------------------------------------------------- */}
      <header className="cl-hero" id="top">
        <div className="cl-container cl-hero-grid">
          <div className="cl-hero-copy rise">
            <p className="cl-eyebrow">TIMO — RELEASE NOTES</p>
            <h1 className="cl-display-xl">Changelog</h1>
            <p className="cl-hero-lead">
              Every Timo release, in one place. Twenty-eight builds in
              twenty-five days — some added features, some fixed what the
              features broke. All of it's here.
            </p>
            <div className="cl-hero-ctas">
              <a className="cl-btn cl-btn--primary" href="#latest">Read the latest</a>
              <a className="cl-btn cl-btn--secondary" href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">Releases on GitHub</a>
            </div>
          </div>
          <div className="cl-hero-stage rise-2" aria-hidden="true">
            <div className="cl-orbit" />
            <img className="cl-mascot" src="/brand/timo-mascot.svg" alt="" width={190} height={190} />
            <span className="cl-fleck cl-fleck--1" />
            <span className="cl-fleck cl-fleck--2" />
            <span className="cl-fleck cl-fleck--3" />
          </div>
        </div>
      </header>

      {/* ---- Black marquee strip: the version ribbon ----------------------- */}
      <div className="cl-marquee" role="presentation">
        <div className="cl-marquee-track">
          <MarqueeRun />
          <MarqueeRun />
        </div>
      </div>

      <main>
        {/* ---- Latest — the signature lime color block ---------------------- */}
        <section className="cl-section" id="latest">
          <div className="cl-container">
            <div className="cl-block cl-block--lime cl-reveal">
              <img className="cl-block-peek" src="/brand/timo-mascot.svg" alt="" width={96} height={96} aria-hidden="true" />
              <p className="cl-caption">LATEST · CURRENT BUILD</p>
              <h2 className="cl-headline">{LATEST.version} — {LATEST.name}</h2>
              <p className="cl-caption cl-block-meta">{LATEST.meta}</p>
              <ChangeList changes={LATEST.changes} />
              <Card src="/brand/timo-card-beta28.gif?v=3" alt="Animated scene: a reliability checklist gets calmly ticked while Timo nods along" w={520} h={210} />
              <p className="cl-block-note">
                You already have this one — Timo updates itself. It checks after
                launch, and again (quietly) when you open Settings. That's the
                whole install guide.
              </p>
            </div>
          </div>
        </section>

        {/* ---- Release ledgers on white canvas ------------------------------ */}
        <section className="cl-section" id="july-2026">
          <div className="cl-container">
            <h2 className="cl-display-lg cl-reveal">July 2026</h2>
            <div className="cl-entries">
              {JULY.map((r) => <ReleaseEntry key={r.id} release={r} />)}
            </div>
          </div>
        </section>

        <section className="cl-section" id="june-2026">
          <div className="cl-container">
            <h2 className="cl-display-lg cl-reveal">June 2026</h2>
            <div className="cl-entries">
              {JUNE.map((r) => <ReleaseEntry key={r.id} release={r} />)}
            </div>
          </div>
        </section>

        {/* ---- Platform — the navy inverse story block ---------------------- */}
        <section className="cl-section" id="platform">
          <div className="cl-container">
            <div className="cl-block cl-block--navy cl-reveal">
              <p className="cl-caption">PLATFORM · DASHBOARD · API · LARK</p>
              <h2 className="cl-headline">The other half just ships.</h2>
              <p className="cl-block-sub">
                The desktop app gets version numbers. The dashboard, API and
                Lark bot deploy quietly behind them — additive migrations,
                verified backups, no drama.
              </p>
              <ul className="cl-platform">
                {PLATFORM.map((p, i) => (
                  <li key={i} className="cl-platform-row">
                    <span className="cl-caption cl-platform-date">{p.date}</span>
                    <span className="cl-platform-text">{p.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ---- Foundation on white canvas ----------------------------------- */}
        <section className="cl-section" id="foundation">
          <div className="cl-container">
            <h2 className="cl-display-lg cl-reveal">Foundation</h2>
            <p className="cl-section-lead cl-reveal">
              The betas were the last mile. Under them: five months of
              milestones, built in order and actually launched at the end of
              each one. No vibes — gates.
            </p>
            <table className="cl-table cl-table--foundation cl-reveal">
              <thead>
                <tr><th>Milestone</th><th>What landed</th></tr>
              </thead>
              <tbody>
                {FOUNDATION.map(([m, what]) => (
                  <tr key={m}><td>{m}</td><td>{what}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="cl-caption cl-foundation-note cl-reveal">
              296 API TESTS BY THE DASHBOARD MILESTONE · 40 CORE + 321 AGENT GREEN ON THE BETA.27 FOUNDATION
            </p>
          </div>
        </section>

        {/* ---- Shipping — coral story block --------------------------------- */}
        <section className="cl-section" id="shipping">
          <div className="cl-container">
            <div className="cl-block cl-block--coral cl-reveal">
              <p className="cl-caption">HOW RELEASES SHIP</p>
              <h2 className="cl-headline">Small, often, and never twice under the same number.</h2>
              <dl className="cl-ship">
                <div className="cl-ship-row"><dt className="cl-caption">CHANNEL</dt><dd>GitHub Releases feeds the built-in updater. You click “Restart to update”. That's your whole job.</dd></div>
                <div className="cl-ship-row"><dt className="cl-caption">MACOS</dt><dd>Developer ID signed and notarized since beta.11. DMG to install, ZIP feed to update.</dd></div>
                <div className="cl-ship-row"><dt className="cl-caption">WINDOWS</dt><dd>NSIS installer, unsigned for v1. Internal IT policy — not laziness.</dd></div>
                <div className="cl-ship-row"><dt className="cl-caption">VERSIONS</dt><dd>Never reused. A number that touches a machine is spent. Ask beta.26.</dd></div>
                <div className="cl-ship-row"><dt className="cl-caption">DATA</dt><dd>Every schema change: additive, backed up, verified. Tracked-time tables don't shrink on deploy day.</dd></div>
              </dl>
            </div>
          </div>
        </section>

        {/* ---- Privacy — the lilac release-notes banner --------------------- */}
        <section className="cl-section">
          <div className="cl-container">
            <aside className="cl-banner cl-reveal">
              <p className="cl-caption">THE CONTRACT EVERY RELEASE KEEPS</p>
              <p className="cl-banner-text">
                Timo counts keystrokes, clicks and scroll — <strong>never
                content</strong>. No clipboard, no mic, no camera. Titles and
                URLs are policy-gated, screenshots retire at 60 days, and
                tracking never stops silently. If Timo isn't counting, it says
                so. Loudly.
              </p>
            </aside>
          </div>
        </section>

        {/* ---- End of log --------------------------------------------------- */}
        <section className="cl-end cl-reveal">
          <img className="cl-end-mascot" src="/brand/timo-mascot.svg" alt="" width={72} height={72} aria-hidden="true" />
          <p className="cl-caption">END OF LOG</p>
          <p className="cl-end-line">
            Timo keeps time. You keep shipping.<span className="cl-cursor" aria-hidden="true" />
          </p>
        </section>
      </main>

      {/* ---- Footer: wordmark + caption link grid --------------------------- */}
      <footer className="cl-footer">
        <div className="cl-container cl-footer-grid">
          <p className="cl-footer-wordmark">Timo</p>
          <div className="cl-footer-cols">
            <div className="cl-footer-col">
              <p className="cl-caption">PRODUCT</p>
              <a href="/home">Dashboard</a>
              <a href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">Get Timo</a>
            </div>
            <div className="cl-footer-col">
              <p className="cl-caption">RELEASES</p>
              <a href="#latest">Latest build</a>
              <a href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">GitHub releases</a>
            </div>
            <div className="cl-footer-col">
              <p className="cl-caption">PRINCIPLES</p>
              <a href="#shipping">How releases ship</a>
              <a href="#foundation">Foundation</a>
            </div>
          </div>
        </div>
        <div className="cl-container cl-footer-legal">
          <p className="cl-caption">© 2026 EMIAC · INTERNAL TOOL · COUNTS, NEVER CONTENT</p>
        </div>
      </footer>
    </div>
  );
}

import type { ReactNode } from 'react';

/**
 * Every Timo release, written once: the changelog prints all of it and the
 * landing page shows the newest few. Static by design — it ships with the
 * build it describes.
 */

export type Tag = 'new' | 'improved' | 'fixed' | 'internal';

export const TAG_LABEL: Record<Tag, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  internal: 'Internal',
};

export interface Change {
  tag: Tag;
  text: ReactNode;
}

export interface Release {
  id: string;
  version: string;
  name: string;
  meta: string;
  lead?: ReactNode;
  changes: Change[];
  extra?: ReactNode;
}

export const LATEST: Release = {
  id: 'beta-37',
  version: 'beta.37',
  name: 'the popup that comes back',
  meta: 'AUG 19, 2026 · MAC + WINDOWS',
  changes: [
    { tag: 'fixed', text: <>The popup comes back after your Mac sleeps. It used to end up on a desktop you were never going to visit — present, floating, and completely invisible.</> },
    { tag: 'fixed', text: <>Timo stopped locking you out. If a prompt could not be found, the tray, the dock icon and every other way in stopped responding too, and only quitting helped. The tray always answers now.</> },
    { tag: 'improved', text: <>Ask for Timo twice and it lets you in. If a prompt is somewhere you cannot reach, Timo gives up on it rather than leaving you outside.</> },
    { tag: 'fixed', text: <>One Timo in the Dock, not five.</> },
    { tag: 'improved', text: <>Prompts now leave a trace in the logs — what appeared, when it was answered, and whether it was ever really on screen. The last fault of this kind hid for four days in plain sight.</> },
  ],
};

export const AUGUST: Release[] = [
  {
    id: 'beta-34',
    version: 'beta.34',
    name: 'the steady hand update',
    meta: 'AUG 15, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>Your timer and your screenshots now agree on what time it is. When they disagreed, a pause could quietly trim minutes you had actually worked.</> },
      { tag: 'improved', text: <>Timo stopped reading from disk every single second. Quieter fans, longer battery.</> },
      { tag: 'improved', text: <>Screenshots wait a moment if you are mid-sentence, instead of stealing the keystroke.</> },
      { tag: 'fixed', text: <>Two silent failures learned to speak up. Both used to happen invisibly and leave you guessing.</> },
    ],
  },
  {
    id: 'beta-31',
    version: 'beta.31',
    name: 'the honest clock update',
    meta: 'AUG 10, 2026 · MAC + WINDOWS',
    changes: [
      { tag: 'fixed', text: <>Your timer runs on a stopwatch now. Correcting a wrong clock used to freeze it mid-count. A stopwatch doesn't know the time, so nobody can lie to it.</> },
      { tag: 'new', text: <>Timo taps you once if you're working with the timer off. Lunch does not count as working.</> },
      { tag: 'fixed', text: <>Prompts stopped dragging you out of fullscreen. They show up where you already are.</> },
      { tag: 'fixed', text: <>No more "Restart Timo" when the screen simply went to sleep. False alarm. Every time.</> },
      { tag: 'fixed', text: <>The permission prompt stopped asking for a restart that could never help. It names the switch it actually wants: Input Monitoring.</> },
      { tag: 'fixed', text: <>Launch at login works on Windows, and repairs itself at boot instead of nagging.</> },
      { tag: 'improved', text: <>Screenshots stopped elbowing your typing.</> },
      { tag: 'fixed', text: <>Windows lost a menu bar it never used. Mac is back to one Dock icon.</> },
    ],
  },
];

export const JULY: Release[] = [
  {
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
  },
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

export const JUNE: Release[] = [
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

export const PLATFORM: Array<{ date: string; text: ReactNode }> = [
  { date: 'JUL 18', text: <>The screenshot carousel stopped gaslighting you. Arrows and keyboard keys now move the photo, timestamp and stats together — never an old frame wearing a new caption.</> },
  { date: 'JUL 16', text: <>The dashboard got fast: team pages answer with summaries first, routes load lazily, JSON travels compressed, assets cache hard. Answers first, details on click.</> },
  { date: 'JUL 15', text: <>The data-safety train reached production — timer lifecycle, runtime health, one canonical timezone. Additive only, backups verified. Not one tracked row rewritten.</> },
  { date: 'JUL 14', text: <>The API learned the new desktop's vocabulary: a permission-paused state, startup health, and device tags on People (admins only).</> },
  { date: 'JUL 13', text: <>One bad activity row can no longer sink a whole batch. Orphans get quarantined with a reason — not a funeral for everyone else's data.</> },
  { date: 'ALWAYS', text: <>The Timo MCP server and the Tester Ops bot keep Lark chat in the loop: approval cards, break summaries with receipts, payroll schedules.</> },
];

export const FOUNDATION: Array<[string, ReactNode]> = [
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

# Grind — Product

> What we're building and why. Read this with [design.md](./design.md) before building any feature. Canonical plan + progress live in the Lark Wiki (see [AGENTS.md](../AGENTS.md)); this is the durable in-repo summary.

## What it is
An **internal** time tracker + screenshot monitor for the agency (~50–200 employees, mostly Mac, some Windows). Hubstaff/WebWork-class, focused on **screenshots + time tracking**, with an admin-only payroll worksheet for classifying payable days. No payment execution, invoicing, or billing. Built on our existing Express + Prisma + Postgres + S3 stack with an Electron + TypeScript desktop agent, a React web dashboard, and deep **Lark** integration.

## Who uses it
- **Member** — tracks their own time; sees their own day/timesheets.
- **Manager** — everything a member has, plus their **team's** data (team-scoped).
- **Admin** — full workspace access; manages users, teams, projects, policy.

## Product principles
1. **Trust through transparency.** The employee can always see that tracking is running (menu-bar ticker + floating bar), and tracking **never stops silently** — any stop surfaces immediately. Missing time is always the employee's explicit choice, never an invisible app failure.
2. **Privacy contract (hard line).** Count keystrokes/mouse/scroll — **never content**. No clipboard, no microphone, no camera. Window titles + URLs default **OFF** (admin opt-in). Anti-cheat signals are content-free and employee-visible/auditable.
3. **Honest visuals.** Show real tracked data (the day-timeline ribbon, real heatmaps), never fake progress metaphors.
4. **Fair measurement.** Activity scoring is **role-aware** (developers ≠ designers ≠ sales); meetings and reading are protected, not penalized.
5. **Calm, premium, mature.** See design.md.

## The three surfaces (desktop agent)
1. **Main window** — the real app: Today (timer + day timeline), Projects, Reports; later task management, screenshots review. Resizable, hidden-inset title bar.
2. **Menu-bar item** — live elapsed-time ticker; click toggles the window; quick popover (start/stop/switch) planned.
3. **Floating bar** — always-on-top timer control for the current entry (survives fullscreen). It stays visible while paused, supports pause/resume in place, and has an explicit close action that hides only the current entry's bar without changing tracked time.

Plus the **web dashboard** (browser) for the heavy manager/admin views: team timesheets, screenshot gallery, activity heatmap, attendance, monthly reports, approvals, admin.

## Core capabilities (target)
- Time tracking with a **segment model** (work / meeting / idle-trimmed); idle discard trims retroactively; crash-safe.
- **Auto-start on boot/wake**; idle detection with an "are you still working?" prompt (popup time never counts).
- **Screenshots**: exact 1/2/3 minute cadence, 3 minutes by default, high quality, fullscreen-safe; 60-day retention; self-serve delete/blur.
- **Activity**: keystroke/mouse/scroll **counts** + content-free timing stats; **role-based productivity score**; **anti-cheat** (impossible rates, jigglers, PyAutoGUI, static-screen) → flag for review, hard-reject only physically-impossible.
- **Lark**: per-user OAuth; **Task** time attribution; **Meet/Calendar** meeting detection; **IM approval cards** for manual-time requests.
- **Attendance**, **monthly reports**, and an admin-only payroll worksheet that classifies shift days without executing payments.

## Scope guards (v1)
**In:** screenshots, time tracking, activity scoring, anti-cheat, attendance, Lark (tasks/meet/IM), role-scoped dashboard.
**Out:** payment execution, invoicing, billing, mobile app, GPS/location, dark mode, public/commercial distribution. SSO deferred to v1.2.

## Build milestones (high level)
M1 timer engine + segments ✅ · **M2 UI foundation + floating bar/menu-bar + auto-start (in progress)** · M3 idle + "still working?" · M4 screenshots + offline queue + S3 · M5 activity capture (+ content-free CV) + active window · M6 meeting detection · M7 Lark app + OAuth · M8 scoring + anti-cheat · M9 Lark task/calendar sync · M10 manual-time → Lark approvals · M11–M12 web dashboard · M13 signing/notarize/auto-update + dogfood. (Full detail: wiki "Build Plan — Tracker + Dashboard".)

## Packaging notes (M13)
- macOS Info.plist must set `NSScreenCaptureUsageDescription` (and later accessibility / input-monitoring usage strings) so the system prompt shows our copy. In dev (unsigned) the permission attaches to the *launching* process (Terminal/Claude); the signed build registers as "Grind".
- A Screen Recording grant requires an app **relaunch** to take effect — the app surfaces a `needs-restart` state + Restart button for this and for mid-session revocation.

## Engineering invariants
- Tests are rigorous and run in CI against a real Postgres; the app is **actually launched** at the end of each milestone, not just unit-tested.
- Every milestone: branch → PR → green CI → spin up for review → merge → wiki sync.
- Module types stay consistent (ESM); native modules rebuilt for Electron's ABI.
- Reuse the design system; reuse `@grind/core` domain logic and `@grind/types` contracts across agent + API.

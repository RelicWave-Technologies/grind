# Manual Testing Guide

How to exercise the app by hand, milestone by milestone. Automated tests cover the logic; this is for confirming the real, end-to-end experience.

## One-time setup

```bash
nvm use                 # Node 20.18 (or current; Node 24 also works with a warning)
corepack enable
pnpm install

# Local Postgres (already running via brew on this machine):
#   grind_dev  — the app's dev database
#   grind_test — used only by the API integration tests
# .env already points DATABASE_URL/DIRECT_URL at grind_dev.

pnpm db:migrate         # apply schema to grind_dev
pnpm db:seed            # creates workspace + abhishek@emiactech.com / grindgrind + 3 projects
```

Run the stack (API + Electron agent, hot-reload):

```bash
pnpm dev
```

- API: http://localhost:4000 (health check: `curl localhost:4000/health` → `{"ok":true}`)
- Agent: an Electron tray app launches; click the menubar/tray icon to open the popup.

---

## M1 — Timer + segments (this PR)

**What to verify:** you can log in, start a timer on a project, watch it tick, stop it, and the time entry + segments land in Postgres. Offline + crash behaviour is safe.

### A. Happy path
1. `pnpm dev`, click the tray icon → **Login**.
2. Sign in: `abhishek@emiactech.com` / `grindgrind`.
3. You'll see the **project picker** (Grind Tracker / Client Work / Admin & Ops).
4. Click a project → the view switches to a **running timer** showing the project name and an elapsed clock ticking every second.
5. Let it run ~30s, then click **Stop** → returns to the picker.

### B. Confirm it persisted server-side
Open Prisma Studio and inspect:
```bash
pnpm db:studio     # opens http://localhost:5555
```
- `TimeEntry` — one row, `endedAt` set, `source = AUTO`, your `userId`.
- `TimeSegment` — one `WORK` segment whose `startedAt`/`endedAt` match the run.

Or via SQL:
```bash
psql grind_dev -c 'SELECT id, "projectId", "startedAt", "endedAt" FROM "TimeEntry" ORDER BY "createdAt" DESC LIMIT 5;'
psql grind_dev -c 'SELECT "timeEntryId", kind, "startedAt", "endedAt" FROM "TimeSegment" ORDER BY "startedAt" DESC LIMIT 5;'
```

### C. Offline resilience (best-effort sync)
1. Start the API (`pnpm dev`), log in, start a timer.
2. Kill **only** the API (Ctrl-C the api process; leave the agent running). The timer keeps ticking — the UI is unaffected by the network.
3. Stop the timer. The entry is saved locally (SQLite) but not yet on the server.
4. Restart the API. Within a few seconds the backlog flushes — re-check Postgres; the entry appears. (Sync also flushes on next agent boot.)

The agent's local DB lives at:
`~/Library/Application Support/@grind/agent/agent.db` (macOS). Inspect with `sqlite3 <path> 'SELECT id, ended_at, synced FROM local_entries;'`.

### D. Crash recovery (no over-counting)
1. Start a timer.
2. Force-quit the agent while it's running (kill the Electron process, or `kill -9`).
3. Relaunch (`pnpm dev`). On boot, the left-open entry is **closed at the last-known-active time** — it never bills the time the app was dead. Confirm in Postgres that the recovered entry has a sane `endedAt` (≈ when you killed it), not "now".

### E. Idempotency / no duplicates
- Stop/start several times rapidly. Each run is one `TimeEntry` (client-generated ULID + idempotency key). Retried syncs never create duplicates — confirm counts in Postgres match the number of runs.

### What is NOT in M1 (don't expect these yet)
- Floating always-on-top bar + menubar ticking timer → **M2**
- Idle detection + "are you still working?" popup → **M3**
- Screenshots → **M4**
- Activity capture, meeting detection, Lark, dashboard → later milestones

---

## Release QA — packaged agent

Use this before calling a desktop release ready. Dev Electron is not enough:
macOS permissions attach to the launched bundle identity, and Windows unsigned
installers have different install and SmartScreen behavior than local dev.

### Evidence to record

Create a short result note in the Lark Updates page with:

- Artifact name and version.
- API URL baked into the agent.
- OS name/version and CPU architecture.
- Tester name and date.
- Pass/fail for each checklist item.
- Blocking issue, reproduction steps, logs/screenshots, and whether a rebuild is required.

### macOS signed/notarized checklist

1. Build or download the intended artifact.
   - Signed/notarized release: `SIGN=1 pnpm --filter @grind/agent package:mac:arm64`.
   - Signed without notarization for internal TCC smoke: `SIGN=1 NOTARIZE=0 pnpm --filter @grind/agent package:mac:arm64`.
2. Verify identity before install.
   - `codesign --verify --deep --strict --verbose=2 "Timo.app"`
   - `codesign -dv --verbose=4 "Timo.app"`
   - `spctl --assess --type execute --verbose=4 "Timo.app"`
   - For notarized builds: `stapler validate "Timo.app"`.
3. Install from the packaged DMG/ZIP, not `electron-vite dev`.
4. Launch Timo and confirm the app name appears as `Timo` in macOS permission prompts/settings.
5. Complete Lark login through the browser and confirm `timo://` returns to the agent.
6. Start a timer and confirm the menu bar/floating/window tracking state is visible.
7. Screen Recording:
   - trigger screenshot capture;
   - confirm the permission state is accurate;
   - grant permission, relaunch, and confirm screenshots capture real pixels.
8. Accessibility/input capture:
   - request permission;
   - relaunch after grant;
   - confirm Settings reports trusted/ready/recording/hook-running truthfully;
   - verify keyboard/mouse counts increase while tracking.
9. Screenshot upload path:
   - capture at least one screenshot;
   - confirm local strip renders it;
   - confirm dashboard report thumbnail opens through `/v1/screenshots/:id/image`.
10. Policy behavior:
    - set app/title/URL capture off and verify the agent does not store/upload active-window fields;
    - set screenshot interval shorter and verify heartbeat config refresh reschedules without restart.
11. Idle behavior:
    - trigger idle threshold;
    - confirm idle discard/trim behavior is visible and does not over-count.
12. Offline/retry:
    - stop API/network;
    - create activity/screenshots;
    - restore network and confirm outbox drains;
    - force screenshot upload failure and confirm failed/retry UI is truthful.
13. Quit/update safety:
    - stop while tracking and verify clean flush;
    - trigger update-ready UI if an update feed is available;
    - confirm install is blocked or deferred while tracking and flushes before restart.

### Windows unsigned installer checklist

1. Build or download the intended unsigned x64 installer.
   - CI path: `Package Windows Agent` workflow.
   - Local Windows path: `pnpm --filter @grind/agent package:win:x64`.
2. Confirm SmartScreen behavior is expected for an unsigned v1 internal build.
   - Warning shown is acceptable only if IT deployment policy still allows install.
   - If install/run is blocked by policy, record as a release blocker.
3. Install via the NSIS installer; verify Start Menu/Desktop shortcuts.
4. Launch Timo from the installed shortcut, not from source.
5. Complete Lark login through the browser and confirm the `timo://` callback reaches the installed app.
6. Start/stop/resume tracking; verify tray/window state and elapsed time.
7. Verify launch-at-login setting persists across sign out/reboot.
8. Capture screenshots and confirm thumbnails/full images render locally and in dashboard reports.
9. Verify keyboard/mouse hook status is truthful and activity counts increase while tracking.
10. Verify activity/screenshot outboxes drain after network interruption.
11. Verify failed screenshot uploads show failed state and retry action.
12. Uninstall and confirm the app is removed cleanly; record whether local data retention needs an IT cleanup step.

### Dashboard regression pass

Use the packaged-agent run above plus the web dashboard to verify the strict
admin-flow fixes together:

1. Policy: 1-minute screenshot/idle settings require an audit reason and appear in Monitoring audit.
2. Team Settings: manager can edit a direct report, cannot self-edit, and 1-minute member settings require a reason.
3. People: admins can set activity role; managers/members cannot self-tune it.
4. Flags: `TIME_INVALIDATED` requires a note and reports affected minutes.
5. Reports/Attendance/Payroll: invalidated time is excluded and shown as audit context.
6. Screenshots: report images load through authenticated API URLs, not storage-provider URLs.
7. Approvals: member requests route manager-first; nobody can approve their own request.
8. Direct URLs: manager can open `/attendance` and is redirected away from `/teams`, `/shifts`, `/policy`, and `/payroll`.

---

## Running the automated tests yourself

```bash
pnpm test                      # everything (core + agent + API integration)
pnpm --filter @grind/core test # pure segment logic (30 tests, no DB)
pnpm --filter @grind/agent test# timer service logic (9 tests, no DB/Electron)
pnpm --filter @grind/api test  # API integration vs grind_test (15 tests, real Postgres)
```

API tests use `TEST_DATABASE_URL` (grind_test) and never touch `grind_dev`. They migrate the test DB and truncate all tables between tests.

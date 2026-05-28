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

## Running the automated tests yourself

```bash
pnpm test                      # everything (core + agent + API integration)
pnpm --filter @grind/core test # pure segment logic (30 tests, no DB)
pnpm --filter @grind/agent test# timer service logic (9 tests, no DB/Electron)
pnpm --filter @grind/api test  # API integration vs grind_test (15 tests, real Postgres)
```

API tests use `TEST_DATABASE_URL` (grind_test) and never touch `grind_dev`. They migrate the test DB and truncate all tables between tests.

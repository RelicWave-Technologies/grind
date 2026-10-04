# AGENTS.md
> Shared context for all AI coding assistants — Claude Code, Codex, Cursor, Gemini CLI, etc.
> This file is symlinked as CLAUDE.md. One source of truth.

---

## MANDATORY: How Every AI Session Must Work

These rules exist so that switching between Claude, Codex, Cursor, or any other tool mid-feature
causes zero context loss. The **Lark Wiki** is the source of truth for all plans and progress.

### Lark Wiki — Source of Truth

All project documentation lives in the **Lark Wiki** under `Tech Hub > 02 — Internal Projects > Grind`.
Use the `lark-wiki` skill (via `lark-cli`) to read and write wiki pages. Do NOT maintain separate
local markdown files for plans or progress — the wiki is canonical.

**Wiki structure:**
```
Grind
├── Grind — Overview
├── Grind — References/
│    └── Time Tracker — Architecture & Tech Plan
└── Grind — Updates/
     ├── Attendance Rules (Sept 2026)/
     │    ├── Plan
     │    └── Updates
     └── Time Tracker MVP/
          ├── Plan
          ├── Updates
          ├── Meeting Updates
          └── Build Plan — Tracker + Dashboard
```

**Wiki page tokens (for lark-cli):**

| Page | obj_token | node_token |
|---|---|---|
| Grind (project root) | `QGnxd7gIRoxFArxDlMYlOVxHgLh` | `CNhTwn36iiIr8JkaFj2lOIHhgOg` |
| Grind — Overview | `AlKKdR05moG61mxkuGblExoDgFh` | `BGgvwBulGibkWAk2BRyl4hVDgWh` |
| Grind — References (parent) | `HuaXdvMxfo3LNJx4OgXlhG9Lg1d` | `MQb7w4C4AimvZekyPO0l8LRvg1g` |
| Grind — Updates (parent) | `F4WAdwmCWoz6EMxX4wKl8JGqgfg` | `RNW7w0sstixBrZkaVlXlOhF5gmc` |
| Ref: Time Tracker — Architecture & Tech Plan | `N2wtdf0yyoED7bxO3hzlMXhsgNh` | `LBOfwqmxoiM7Q5kUl1zlGVK3gLh` |
| Ref: Design System — Apple HIG (Light/Premium) | `TOjOdT9xMoM7iMxeCbglipRYgkc` | `WOtMw4IbfiXkRjksLoQlC0lrgo3` |
| Ref: API Reference — Third-Party Integration (v1) | `Q7kPdVd6joS1wixnn5glHv9lgBe` | `HSyvwIDVUiF7LkkjGsgl9Km9grx` |
| Feature: Time Tracker MVP (folder) | `C1NPdC66lofn7cxfkqUljzoKgYb` | `HxJowzMc2iPScmkRU26lGn6Dgpg` |
| Time Tracker MVP — Plan | `GDWodW56fofwChxzlYvlZcRxgA3` | `WsSvwBc4aiYz1ykMX00lsno0gIc` |
| Time Tracker MVP — Updates | `N7vkdocUsoNgB7xmcIUlWCWigyh` | `J0HLw1Lrni5cyPkK58YlbIn1gth` |
| Time Tracker MVP — Meeting Updates | `ASuwdpd59obMm6xS1MOlet3eg4b` | `E36Fw9BkLiphzCkgvMtl0DX8gIg` |
| Time Tracker MVP — Build Plan (Tracker + Dashboard) | `EVded8JgToBkXVxLvOfle6BygUc` | `UicZwET2Oi9vKJkQR9tlMG0BgHf` |
| Feature: Attendance Rules (folder) | `HbjxdygzAo5k3jxQEtMlbDHYgvg` | `FfMpw3EKHipTaMkkLHKlIHnygeb` |
| Attendance Rules — Plan | `QH1OdrshDoqhjhx73KKlJnvsgkh` | `M1lIw2JmliENc2ktblFlRoWrgzc` |
| Attendance Rules — Updates | `TzdxdXR0Tou3kLxePeKlAtp7gkh` | `QRXbwrFEpiVrdtkugf0lq4hvgxn` |

**Wiki space ID:** `7635896570625396443` (Tech Hub)
**Project node token:** `CNhTwn36iiIr8JkaFj2lOIHhgOg`

### How to read/write wiki pages

```bash
# Read a page
lark-cli docs +fetch --api-version v2 --doc <obj_token> --doc-format markdown

# Overwrite a page (content must be a relative path with v2)
lark-cli docs +update --api-version v2 --doc <obj_token> --command overwrite --doc-format markdown --content @.context/file.md

# Append to a page
lark-cli docs +update --api-version v2 --doc <obj_token> --command append --doc-format markdown --content "content"

# Create a new sub-page
lark-cli wiki +node-create --space-id 7635896570625396443 --parent-node-token <PARENT_NODE> --title "Title"
```

### At the START of every session
1. Fetch the **Updates** page for the active feature from wiki (obj_token `N7vkdocUsoNgB7xmcIUlWCWigyh` for Time Tracker MVP)
2. Read its **Current State** — this is where the last session left off
3. If the request doesn't match any existing feature, ask before creating code

### During a session
- Architecture decisions go to the feature's **Plan** page (Key Decisions table)
- Blockers go to the feature's **Updates** page immediately

### At the END of every session (before stopping)
1. Overwrite the **Updates** page with a fresh snapshot:
   - What is working
   - What is in progress (file + function level)
   - What is not started
   - Exact next action
   - Append a progress log entry (date, tool, what you did)
2. Write snapshot to `.context/` first, then push via `lark-cli docs +update`

**This is not optional.** Treat updating the wiki as the last action in every session.

### When starting a brand-new feature
1. Create a folder under `Grind — Updates` with **Plan** and **Updates** sub-pages
2. Fill in the Plan before writing code
3. Add the new tokens to the table above

---

## Project quick facts

- **Stack:** Desktop app moving from Electron (`legacy/agent`) to Tauri 2 + Rust (`apps/desktop` + `crates/`) · Express + Prisma + Postgres + S3 backend · React + Vite dashboard · pnpm workspaces + Turborepo
- **Scope:** Internal-use Hubstaff-style tracker — screenshots + time tracking only. No payroll, no invoicing.
- **Privacy contract:** count keystrokes/mouse, never content. Window titles + URLs default OFF. 60-day screenshot retention.
- **Signing:** macOS signing via Apple Developer account. Windows ships unsigned for v1 (internal IT deployment).

## MANDATORY: Desktop — Tauri + Rust

The desktop app is being ported from Electron (`legacy/agent`) to Tauri 2 + Rust. **Only the React renderer stays TypeScript.** Everything else the desktop app does — timer engine, ledgers, SQLite, activity counting, idle/sleep/lock, screenshots, sync, auth, updater, windows, tray — is Rust.

**Tracked time pays salaries. The port must reproduce the TypeScript behaviour exactly — not "equivalently", exactly.** These rules exist for that:

1. **`legacy/agent` is the oracle and is frozen.** It stays buildable and tested and ships releases until cutover. Do not change its behaviour. If a real bug is found in it, fix it in both, in the same commit, and say so.
2. **Every ported function names its source.** A doc comment says which TS file/function it matches (`// Port of legacy/agent/src/main/services/timer/timerService.ts::TimerService.pause`). Deliberate quirks are copied, not fixed, and listed in the crate's `PARITY.md` for a post-cutover decision.
3. **Proof is golden output from the real TypeScript, never a second reading of the code.** `parity/` runs the legacy TS functions (and `packages/core`) over fixed edge cases *and* seeded random scenarios and writes JSON fixtures into the Rust crates' `tests/fixtures/`. `cargo test` must reproduce them byte for byte. The TS unit tests are also ported 1:1 (same names, same cases).
4. **Numbers: JS semantics, spelled out.** Time is `i64` milliseconds. `Math.round`/`floor`/`ceil`, `toFixed`, integer division, `Date` and `Intl` behaviour go through `timo_core::js` helpers that reproduce JavaScript exactly (`Math.round(-33.5) === -33`; Rust's `f64::round` gives -34). `as` casts are a lint error.
5. **Time and ids are injected.** No `SystemTime::now()`/`Instant::now()`/random ids inside `timo-core`; they arrive as arguments or via `Clock`/`IdGen` traits, exactly as the TS `Clock`/`IdGen` seams do.
6. **Same database.** `timo-store` opens the existing `agent.db` with the identical schema; an upgraded install keeps its entries, queue and liveness.
7. **Windows is first-class from the first commit, not a later pass.** Every platform feature lands for macOS and Windows together, behind `#[cfg(target_os)]`, with the decision logic in a pure function that tests on any host. CI runs `cargo check` + tests on `windows-latest`.

**Crates:** `timo-core` (pure logic, no I/O, `forbid(unsafe_code)`) · `timo-store` (rusqlite) · `timo-sync` (HTTP client, sync drains, uploader, auth) · `timo-platform` (macOS/Windows FFI; the only crate allowed `unsafe`, each block with a `// SAFETY:` comment) · `apps/desktop/src-tauri` (windows, tray, IPC commands, wiring only — no business logic).

**Code rules** (lint-enforced in `Cargo.toml`/`clippy.toml`): no `unwrap`/`expect`/`panic`/indexing in non-test code; functions ≤ 50 lines and ≤ 4 parameters; files ≤ 300 code lines — split, don't raise; errors via `thiserror`, no `anyhow`; `#[allow]` needs a `reason`; dependencies pinned exactly (`=x.y.z`) in the workspace `Cargo.toml` only. Small single-purpose modules; no abstraction with one implementation.

**Tauri pitfalls already paid for** (from Airnote, `~/Desktop/Cluster/Projects/Airnote spread`):
- Creating a WebView2 window inside an IPC handler deadlocks on Windows (wry #583): create every window hidden during `setup`, then only show/hide.
- Window operations from a command freeze Windows (tao #381): always `run_on_main_thread`.
- `async` commands exhaust WebView2's ~6-connection pool: keep cheap getters synchronous.
- A panic inside an AppKit callback aborts the process: wrap tray/window/main-thread callbacks in `catch_unwind` (`guard_panics`).
- NSPanel: `can_join_all_spaces + full_screen_auxiliary`, never with `stationary` (Tauri #5566). `no_activate` hides the app; restore after.
- The Windows low-level hook thread must pump messages; the macOS event tap is disabled on timeout and must be re-armed.

**Gates before every commit:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, the parity fixtures regenerated and unchanged, and `pnpm typecheck`. Commit bodies state what was proven and name anything not provable.

## MANDATORY: Design & product consistency

Before building ANY user-facing feature, read:
- **`DESIGN.md`** (repo root) — the design system: Timo in the EMIAC house style (white and quiet, EMIAC blue for tracked time and the one primary action, Instrument Sans never bold, 20px hairline cards). Its front matter generates the CSS tokens in `@grind/design` (`packages/design`) that both apps import. Use tokens; never hardcode hex/px/fonts. If a value isn't there, add it to `DESIGN.md` first.
- **`docs/product.md`** — what we're building, who for, principles, scope guards, the three surfaces, privacy contract.

Desktop agent and web dashboard MUST share the same design system. Keep both docs current when the system changes.

## Seeing a UI change without a backend or Electron

Check every visual change by looking at it (DESIGN.md is the spec; the screen is the proof):

- **Dashboard on dummy data** — `pnpm dev:mock` (Vite + HMR on :5174; if that port is taken, run `pnpm --filter @grind/dashboard exec vite --mode mock --port 5177` instead, because pnpm passes a `--` through to Vite rather than swallowing it). Every `/v1` call is answered in the browser from `apps/dashboard/src/mock/`, with dates relative to today. The DEV panel (bottom-left, Alt+Shift+M) switches Admin / Manager / Member, signed out, latency, empty workspace and errors. Production builds contain none of it.
- **Desktop app in the browser ("Agent Lab")** — `pnpm lab` → http://localhost:5176/lab/. Every renderer window (main tabs, tray popover, floating bar, prompts, ready-to-work) at its real size on a fake `window.agent` bridge, with scenario switches (tracking, paused, signed out, Lark states, permissions…) and a Palette switch for trying accents. Edits under `apps/agent/src/renderer` hot-reload in every frame. Lives in `apps/agent/lab/`, outside the Electron build.
- **Brand assets** — `pnpm --filter @grind/agent icon` regenerates the app icon, favicon and menu-bar icons from `apps/agent/src/renderer/assets/timo-logo.svg`.

## Local paths

- `DESIGN.md` — design system (canonical, in-repo; `docs/design.md` points to it, old systems in `docs/archive/`)
- `docs/product.md` — product overview (canonical, in-repo)
- `tracker-plan/PLAN.md` — local copy of the architectural plan (also pushed to wiki under References)
- `.context/` — scratch dir for wiki-sync snapshots; do not commit large files here

# @grind/desktop

The Timo desktop app on **Tauri 2 + Rust**. Only the React renderer is TypeScript.
It replaces the frozen Electron app in `legacy/agent`, which stays the parity oracle
until cutover (see root `AGENTS.md`, "Desktop: Tauri + Rust").

```
apps/desktop
  index.html, src/        the renderer, copied unchanged from legacy/agent/src/renderer
  src/shared/             renderer-facing types, copied from legacy/agent/src/shared
  src/bridge/             window.agent on Tauri (agentBridge.ts + its test)
  src/generated/          Rust DTO types written by ts-rs (committed)
  lab/                    Agent Lab: every window in a browser on a fake bridge, no Tauri
  scripts/                make-icon.mjs, the app-region Vite plugin, the README table printer
  src-tauri/              Rust crate `timo-desktop` (workspace member): windows, tray, IPC wiring only
```

## Run

```sh
pnpm --filter @grind/desktop tauri dev        # the app, hot-reloading the renderer
pnpm lab                                      # Agent Lab at http://localhost:5176/lab/ (no Tauri)
pnpm --filter @grind/desktop icon             # regenerate src-tauri/icons (app + tray) from the logo
pnpm --filter @grind/desktop bindings         # regenerate src/generated/*.ts from the Rust DTOs
pnpm --filter @grind/desktop typecheck && pnpm --filter @grind/desktop test
cargo clippy -p timo-desktop --all-targets -- -D warnings && cargo test -p timo-desktop
```

Debug builds only (both compiled out of release builds):

- `TIMO_DEV_SHOW=popover,floating,attention,ready` shows those windows shortly after launch,
  so each can be looked at without the services that normally show them.
- `TIMO_DEV_LAB=lab&prompt=PERMISSION` appends that query to every window URL, which makes the
  renderer use the Agent Lab's fake `window.agent` (`lab/devWindow.ts`) inside the *real* Tauri
  windows: real transparency, shadows, placement, panel levels, with realistic content while the
  services are unported. Without it the overlays render empty, because every command rejects.

The debug binary loads the Vite dev server, so run `pnpm --filter @grind/desktop dev` first (or use
`tauri dev`, which does it). When launching it from a script, keep it under a parent you control
and stop it with SIGTERM: a detached `target/debug/timo-desktop` has no `.app` bundle and leaves a
generic "exec" icon in the Dock.

### Checking Windows from a Mac

`cargo check -p timo-desktop --target x86_64-pc-windows-msvc` needs a C toolchain that can target
MSVC (the `ring` build script compiles C) and an `llvm-rc` (the Tauri build script embeds a
Windows resource). Without them it stops in `ring` with `assert.h not found`: that is the host, not
the crate. It was run here with the Windows SDK headers from `xwin` (`xwin splat`), Apple `clang`
with `--target=x86_64-pc-windows-msvc -isystem <xwin>/{crt,sdk}/include/...`, and `llvm-lib` /
`llvm-rc` from an Android NDK, via `CC_/AR_/CFLAGS_x86_64_pc_windows_msvc` and `PATH`. CI
(`.github/workflows/desktop.yml`) runs the real thing on `windows-latest`.

## Identity

`identifier` is `com.relicwave.grind`, the same bundle id as the Electron app. macOS keys
Screen Recording and Accessibility grants on it, so an upgraded install keeps them.
User data stays in Electron's `userData` folder (`<appData>/Timo`, see `src-tauri/src/paths.rs`),
not Tauri's identifier-keyed `app_data_dir()`, so `agent.db` is the same file.

## Typed IPC: ts-rs, not tauri-specta

Checked 2026-10-04 (crates.io):

| | Latest stable | Tauri 2 |
| --- | --- | --- |
| `tauri-specta` | `1.0.2`, which targets **Tauri 1** | only the pre-release `2.0.0-rc.25` (pins `specta =2.0.0-rc.25`) |
| `ts-rs` | `12.0.1` | independent of Tauri (plain `serde` types) |

`tauri-specta` has never had a stable release for Tauri 2, and the repo's rule is exact
pins on things that can pay someone's salary wrong. So: **`ts-rs =12.0.1`**, pinned in the
workspace `Cargo.toml`. Tauri itself is `=2.12.1` (Tauri 3 is alpha); `@tauri-apps/api` and
`@tauri-apps/cli` are pinned to the same `2.12.1`.

What that buys and what it does not: ts-rs generates the **DTO types** (`#[derive(TS)]`,
`#[ts(export)]`, written to `src/generated/` by `cargo test -p timo-desktop export_bindings`),
not the command signatures. The bridge's `RUST_DTO_CONTRACT` (compile-time) fails
`pnpm typecheck` if a Rust DTO no longer fits what the renderer declares. Command names and
argument shapes are covered by the table below, the bridge test, and a Rust test that every
registered command is granted to a window. When the number of commands makes that table the
weak link, revisit tauri-specta once it ships a stable Tauri 2 release.

## The bridge

The renderer talks only to `window.agent` (type: `lib/agent.d.ts`, same shape as the Electron
preload). `src/bridge/agentBridge.ts` implements it on `invoke` and `listen`:

- Channel `timer:start` is command `timer_start`; camelCase becomes snake_case
  (`auth:loginWithLark` is `auth_login_with_lark`).
- Positional arguments become the named arguments the command takes (`login(email, password)`
  sends `{ email, password }`), so Rust command parameters are snake_case versions of those names.
- Push events keep their channel names as Tauri event names. Every `on*` returns a synchronous
  unsubscribe, also when called before `listen` has resolved.
- A command with no Rust handler rejects with `not ported yet: <command>`. Nothing is faked.
  `settings.get` is the one composite: it merges `settings_get` (version, platform: ported)
  with `settings_get_services` (not ported), so it rejects until both exist.
- `src/dragRegions.ts` replays the stylesheet's `-webkit-app-region` rules (extracted at build
  time by `scripts/appRegionPlugin.ts`) as `startDragging()` calls, because WKWebView ignores
  that CSS property. No screen changed.
- Outside Tauri, or when a `window.agent` already exists (the lab's fake one), the bridge does
  not install.

| Channel | Tauri command | Rust |
| --- | --- | --- |
| `auth:login` | `auth_login` | not ported |
| `auth:loginWithLark` | `auth_login_with_lark` | not ported |
| `auth:logout` | `auth_logout` | not ported |
| `auth:status` | `auth_status` | not ported |
| `auth:me` | `auth_me` | not ported |
| `agent:status` | `agent_status` | not ported |
| `workspaceTime:get` | `workspace_time_get` | not ported |
| `timer:start` | `timer_start` | not ported |
| `timer:pause` | `timer_pause` | not ported |
| `timer:stop` | `timer_stop` | not ported |
| `timer:resume` | `timer_resume` | not ported |
| `timer:status` | `timer_status` | not ported |
| `timer:lastTaskGuid` | `timer_last_task_guid` | not ported |
| `timer:recoveryNotice` | `timer_recovery_notice` | not ported |
| `timer:dismissRecoveryNotice` | `timer_dismiss_recovery_notice` | not ported |
| `timer:today` | `timer_today` | not ported |
| `window:openMain` | `window_open_main` | ported |
| `window:dismissFloatingBar` | `window_dismiss_floating_bar` | ported |
| `attention:get` | `attention_get` | not ported |
| `attention:resolve` | `attention_resolve` | not ported |
| `attention:yieldToSystemSettings` | `attention_yield_to_system_settings` | not ported |
| `shift:decide` | `shift_decide` | not ported |
| `shift:refresh` | `shift_refresh` | not ported |
| `shift:today` | `shift_today` | not ported |
| `shift:promptReason` | `shift_prompt_reason` | not ported |
| `screenshots:recent` | `screenshots_recent` | not ported |
| `screenshots:countToday` | `screenshots_count_today` | not ported |
| `screenshots:captureOnce` | `screenshots_capture_once` | not ported |
| `screenshots:thumbnail` | `screenshots_thumbnail` | not ported |
| `screenshots:full` | `screenshots_full` | not ported |
| `screenshots:uploadSummary` | `screenshots_upload_summary` | not ported |
| `screenshots:retryFailedUploads` | `screenshots_retry_failed_uploads` | not ported |
| `permissions:readiness` | `permissions_readiness` | not ported |
| `permissions:requestScreen` | `permissions_request_screen` | not ported |
| `permissions:screen` | `permissions_screen` | not ported |
| `permissions:accessibility` | `permissions_accessibility` | not ported |
| `permissions:requestAccessibility` | `permissions_request_accessibility` | not ported |
| `settings:get` | `settings_get` | ported |
| `settings:getServices` | `settings_get_services` | not ported |
| `settings:repairLaunchAtLogin` | `settings_repair_launch_at_login` | not ported |
| `settings:moveToApplications` | `settings_move_to_applications` | not ported |
| `settings:setFloatingBarVisible` | `settings_set_floating_bar_visible` | not ported |
| `settings:resetFloatingBarPosition` | `settings_reset_floating_bar_position` | not ported |
| `settings:openScreenPrefs` | `settings_open_screen_prefs` | not ported |
| `settings:openInputMonitoringPrefs` | `settings_open_input_monitoring_prefs` | not ported |
| `settings:openStartupPrefs` | `settings_open_startup_prefs` | not ported |
| `settings:openDataFolder` | `settings_open_data_folder` | ported |
| `app:relaunch` | `app_relaunch` | ported |
| `app:openDashboard` | `app_open_dashboard` | not ported |
| `updates:status` | `updates_status` | not ported |
| `updates:checkNow` | `updates_check_now` | not ported |
| `updates:checkQuietly` | `updates_check_quietly` | not ported |
| `updates:installNow` | `updates_install_now` | not ported |
| `insights:today` | `insights_today` | not ported |
| `lark:status` | `lark_status` | not ported |
| `lark:connect` | `lark_connect` | not ported |
| `lark:disconnect` | `lark_disconnect` | not ported |
| `lark:tasks` | `lark_tasks` | not ported |
| `lark:sync` | `lark_sync` | not ported |
| `lark:createTask` | `lark_create_task` | not ported |

Push events: `auth:status:push`, `auth:lark:push`, `workspaceTime:push`, `timer:status:push`, `attention:state:push`, `shift:promptReason`, `screenshots:changed`, `settings:open:push`, `updates:status:push`, `updates:open-settings`, `lark:connection:push`

"Rust" is read from `src-tauri/src/commands/names.rs`; `agentBridge.test.ts` fails if this table
and that file disagree, or if any `AgentBridge` method lacks an implementation.
Regenerate the table with `pnpm --filter @grind/desktop exec vite-node scripts/bridgeTable.ts`.

## Windows

All five are created hidden in `setup` (creating a WebView2 window inside an IPC handler
deadlocks, wry #583) and only shown and hidden afterwards, always through `run_on_main_thread`
inside `guard_panics`. `src-tauri/src/windows/spec.rs` is the source of this table.

| Window (label) | Route | Legacy Electron | Tauri |
| --- | --- | --- | --- |
| Main (`main`) | `#` (App) | 960x640, min 720x460, `titleBarStyle: hiddenInset`, traffic lights at (16,18), `backgroundColor #F2F2F7`, hidden until ready (unless a login launch), close hides | same sizes, `TitleBarStyle::Overlay` + `hidden_title` + `traffic_light_position(16,27)` (macOS; tao's y is not Electron's, 27 puts the lights' centres at (23,25) as Electron's 18 does, measured 22.8, 24.8), `background_color #F2F2F7`, created hidden, shown from `RunEvent::Ready` unless `--hidden`, close hides |
| Popover (`popover`) | `#popover` | 300x340 overlay, ambient, default shadow, hides on blur, anchored under the tray icon | 300x340, NSPanel (key-capable) on macOS, hides on blur, placed by a port of `trayPopoverPoint` |
| Floating bar (`floating`) | `#floating` | 268x44 overlay, ambient, no shadow, no rounding, bottom-right of the active display (gutter 20) | 268x44, no shadow, bottom-right of the display under the cursor (gutter 20) |
| Prompts (`attention`) | `#attention` | 480x332 at creation (resized per prompt), prompt rank, rounded corners, centred or top-right | 480x332, panel level one above the furniture, centred |
| Ready to work (`ready-to-work`) | `#ready-to-work` | 320x168 overlay, ambient, top-right (gutter 16) | 320x168, top-right (gutter 16) |

Every overlay is frameless, transparent, non-resizable, non-minimizable/maximizable, out of the
taskbar, always on top, on every workspace, not focused when shown. On macOS it is a
non-activating `NSPanel` (level 28, prompts 29; `can_join_all_spaces` + `full_screen_auxiliary`,
never `stationary`) so it floats over fullscreen apps without switching Spaces. On Windows it is
a plain always-on-top, skip-taskbar, transparent window.

Capabilities (`src-tauri/capabilities/`) are scoped per window: `main.json` for the main window,
`overlay.json` for the four overlays. Custom commands get one `allow-<command>` permission each
(generated by `build.rs` from `names.rs`), so an overlay can call only what `overlay.json` grants.

## Gaps against the Electron windows

Everything here needs services that are not ported yet, or is a deliberate difference.

- **No keep-on-top keeper.** Legacy re-asserts float, workspace membership and order-to-front at
  1 Hz while an overlay is up, and again after sleep, unlock and display changes (`overlay.ts`
  `keepOnTop`, `reassertAllOverlays`). Not ported. Overlays here are placed above on `show` only.
- **Panel level 28/29, not `screen-saver` (1000).** Legacy used the `screen-saver` level plus a
  relative offset for prompts. This uses Airnote's proven level 28 (prompts 29). Whether 28 clears
  every fullscreen app Timo users run is unverified here.
- **No Windows ambient/prompt suppression.** Legacy skips an ambient overlay's raise while a prompt
  is held, because Windows collapses every topmost level into one band. Needs the keeper first.
- **Floating bar position is always the default corner.** Saved (dragged) position, off-screen
  recovery and `resetFloatingBarPosition` need the preferences service.
  `window_dismiss_floating_bar` hides the bar but does not remember the dismissal for the entry.
- **Prompts are not resized or re-placed per prompt kind** (340x280, 360x222, 480x332) and the
  activate-once-per-presentation rule is not implemented.
- **No `roundedCorners` switch.** Tauri has none; transparent frameless windows draw their own
  radius in CSS, which is what the renderer already does.
- **Traffic-light spacing** is 23pt centre to centre, Electron's is 20pt (tao spaces them, measured
  from a screenshot). First light and vertical position match.
- **Launch activation.** From `RunEvent::Ready` the main window is shown, then shown once more
  700 ms later. Measured on macOS from a terminal-started debug binary: one show left the app
  inactive and the window parked behind the frontmost app (Stage Manager thumbnailed it) in 3 of 3
  runs; with the second show it came forward in 6 of 6. Finder/Dock launches activate the app
  anyway, so this is belt and braces and has not been checked on a packaged `.app`.
- **Windows main window** uses the native title bar (Electron's `hiddenInset` is macOS-only).
  Electron sizes include the frame; Tauri's `inner_size` does not, so the Windows window is
  slightly taller than 640 overall.
- **Tray:** no elapsed-time title and no "Restart to update" item (timer and update services).
  macOS has no stable tray GUID API, so the menu-bar item's remembered position may differ.
- **Autostart** is registered but never enabled. The plugin's macOS launcher is a LaunchAgent,
  which differs from the Login Item Electron used; decide before porting `launchAtLogin`.
- **Updater** is registered with an empty endpoint list and a throwaway public key (its private
  half was discarded). Updates cannot be delivered until a real key and endpoint are set.
- **`timo://` links** are registered as a scheme but nothing handles them yet (Lark login).
- **Notifications** plugin is registered; nothing sends one yet.
- **`app_relaunch`** restarts immediately; legacy runs quit cleanup (flush timer and queues) first.

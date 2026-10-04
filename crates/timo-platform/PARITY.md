# timo-platform — deliberate quirks and open differences

Copied, not fixed, for a post-cutover decision (AGENTS.md rule 2). Each is covered by a test.

## Copied from libuiohook (what legacy counts today)

1. **macOS: releasing a middle/extra mouse button counts as a second click.** libuiohook's
   `kCGEventOtherMouseUp` case calls `process_button_pressed`. Left/right release do not.
   Proven on this Mac: real `uiohook-napi` and this crate both reported `mousedown = 2` for one
   other-button press + release (`tests/hardware_mac.rs`).
2. **macOS: each modifier press counts as a keystroke, and releasing one shift while the other is held
   counts again** (both shifts share one flag bit; libuiohook tests "flag set after change").
3. **macOS media keys:** only `NX_KEYTYPE` 0, 1, 4, 7, 14, 16, 19, 20 count. Fast/rewind (19/20) count;
   next/previous (17/18) and brightness do not.
4. **Auto-repeat counts.** A held key is a stream of key-downs on both OSes.
5. **Windows: a pointer move to exactly the last click point is dropped**; the initial "last click" is (0,0) and, like libuiohook's file-level static, it **survives hook stop/start** (process-static here too).
6. **Coordinates are `int16`.** Windows wraps (two's complement) beyond ±32 767; macOS saturates
   (C is undefined there). Multi-monitor layouts that large do not exist in practice.
7. **Windows: a non-elevated process receives no input while a UAC-elevated window has focus**
   (legacy comment in `permissions.ts`). Counts under-report for admin apps.
8. **Windows idle time is one ms short across a tick-counter wrap** (Chromium's arithmetic).
9. **macOS idle time truncates; Windows floors.** Both whole seconds, as Electron.
10. **`getSystemIdleState`: locked beats idle; idle is `>=`.**
11. **macOS screen status can only be `granted`/`denied`** on this Electron, and can be stale after a toggle.

## Differences from legacy, on purpose

| | Legacy | Here | Why |
|---|---|---|---|
| macOS tap | active tap, Accessibility gate | **the same**: `kCGSessionEventTap`, head-insert, `kCGEventTapOptionDefault`, libuiohook's exact mask, gated on `AXIsProcessTrusted` (no prompt, as legacy) | exact parity of the permission an upgraded install needs. An earlier listen-only/Input-Monitoring design was dropped: it was unproven for users who hold only Accessibility, and a non-null tap can be mouse-only. `Granted` is reported only after the Accessibility gate. If the tap still cannot be created the error says so (and names Input Monitoring if that preflight is also false). |
| macOS suspend/resume source | IOKit via Chromium (+ a dead NSWorkspace-on-distributed-centre path) | IOKit only, de-duplicated identically | the dead path never fires |
| Windows suspend/resume | emitted twice (Electron window + Chromium window) | emitted once | legacy handlers are idempotent |
| Windows `shutdown` | not emitted | **not emitted** (same) | a message-only window cannot receive `WM_ENDSESSION`; Windows session end is handled at the app layer (top-level window) and is to be wired in the Tauri app |
| Windows lock registration | Electron ignores a `WTSRegisterSessionNotification` failure | bounded retry on `RPC_S_INVALID_BINDING` (≈ 7.75 s), then `Err` + teardown | a monitor that cannot see locks is never reported as started |
| macOS lock/screensaver/power-off delivery | main thread (Electron is single-threaded) | observed on the main thread (Foundation), then handed to the monitor thread; the sink only ever runs on the monitor thread | **the host's main run loop must run** (a Tauri app's does; the probe pumps it). Latency is a `CFRunLoopPerformBlock` hop. |
| Event delivery | N-API threadsafe function, unbounded | unbounded queue + dispatcher thread; **no event is ever dropped** | exact parity; a stalled sink only grows memory, as in legacy |
| One listener per process | n/a | enforced (`AlreadyRunning`) | Windows hook procs have no user-data slot |
| Windows wheel when `SystemParametersInfo` fails | event ignored | counted | libuiohook ignores the event if that call fails; it does not fail in practice |

## Open / unproven

See the report: nothing here has run on real Windows; macOS lock/unlock/sleep/wake/power-off
delivery is by construction and source reading, not observed.

## Screenshot capture (`src/capture/`)

Copied, not fixed, for a post-cutover decision:

1. **Small displays are enlarged.** Chromium's thumbnailer letterboxes into 2560×2560 *with*
   enlargement, so a 1920×1080 monitor is stored as 2560×1440 (a 1.8× bigger WebP holding no more
   detail) and the reported `width`/`height` say so. `size::chromium_thumbnail_size`.
2. **Colours are not converted to sRGB.** The display's own colour space's numbers are stored as is.
3. **The cursor is not drawn.** `CGDisplayCreateImage` and GDI `BitBlt` do not include it.
4. **`capturedAt` is sampled after the pixels**, by the caller, as legacy does (≈ the capture's duration
   late). `capture_now` returns no time and no id on purpose.
5. **A failed or zero-sized display is "blank"**, which makes health `empty` when nothing else
   succeeded, as legacy's empty thumbnail does; an OS failure on every display looks the same.
6. **The day folder is the UTC date of `capturedAt`**, not the workspace's.

Differences on purpose:

| | Legacy | Here | Why |
|---|---|---|---|
| Windows capturer | DXGI, GDI fallback | GDI only | see `ELECTRON-PARITY.md` §6; unproven on real Windows either way |
| Downscale kernel | libyuv bilinear (Chromium), then libvips Lanczos3 (no-op) | `fast_image_resize` bilinear, once | pixels differ by a few levels from legacy's; sizes are identical |
| Pixel-format check | none (assumes BGRA) | checked; a different format is blank | no silent colour noise on an HDR/half-float image |
| Multiple frames in memory | all thumbnails at once | one display at a time in `capture_now` | a 3×4K setup is ~100 MB of raw pixels |
| WebP encoder in the crate | n/a | Cargo feature `encode` (default on) | `libwebp-sys` is C; a Mac cannot cross-`check` it for `x86_64-pc-windows-msvc` (no MSVC headers), so `--no-default-features` is how the Windows-only code is type-checked there |

Open: nothing in `capture/windows.rs`, `win_gdi.rs` or `win_config.rs` has run on real Windows.

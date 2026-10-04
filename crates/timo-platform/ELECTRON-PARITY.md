# Electron / libuiohook parity — what the legacy agent actually gets, and where from

Oracle: `legacy/agent` on **Electron 33.2.0** (Chromium **130.0.6723.118**) with
**uiohook-napi 1.5.4** (its bundled libuiohook, read from
`node_modules/uiohook-napi/libuiohook/`). Everything below was read from those exact
versions, not from `main`. Where `main` differs it is noted.

Bases used in the links:

* Electron: `https://github.com/electron/electron/blob/v33.2.0/`
* Chromium: `https://github.com/chromium/chromium/blob/130.0.6723.118/`
* libuiohook upstream: `https://github.com/kwhat/libuiohook` (the copy legacy ships is
  the one in `node_modules/uiohook-napi/libuiohook`, read locally)
* uiohook-napi: `https://github.com/SnosMe/uiohook-napi` (`src/lib/addon.c`, `dist/index.js`, `binding.gyp`)

## 1. Idle time — `powerMonitor.getSystemIdleTime()`

Electron: `shell/browser/api/electron_api_power_monitor.cc` → `ui::CalculateIdleTime()`.

| OS | Chromium source | Behaviour |
|---|---|---|
| macOS | `ui/base/idle/idle_mac.mm` ([link](https://github.com/chromium/chromium/blob/130.0.6723.118/ui/base/idle/idle_mac.mm)) | `static_cast<int>(CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType))`. **Truncated** to whole seconds. `kCGEventSourceStateCombinedSessionState` = 0, `kCGAnyInputEventType` = `~0` (checked in the SDK headers). |
| Windows | `ui/base/idle/idle_win.cc` ([link](https://github.com/chromium/chromium/blob/130.0.6723.118/ui/base/idle/idle_win.cc)) | `GetLastInputInfo().dwTime` vs `GetTickCount()`, both `DWORD` ms. If `now < last` the tick counter wrapped once: `(MAX − last) + now` (one ms short of the true gap — kept). Then `/ 1000` (floor). A failed `GetLastInputInfo` gives 0. |

Ported as `idle::system_idle_seconds`; the arithmetic is the pure `mac_idle_seconds` /
`windows_idle_seconds`. Out-of-range macOS values: the C++ cast is undefined; on arm64
(Electron on Apple Silicon) it saturates and NaN → 0. Rust's float `as` does the same.

## 2. Idle state — `powerMonitor.getSystemIdleState(threshold)`

`electron_api_power_monitor.cc`: throws `"Invalid idle threshold, must be greater than 0"`
unless `threshold > 0` (→ `PlatformError::InvalidIdleThreshold`). Strings: `active`, `idle`,
`locked`, `unknown`. Chromium `ui/base/idle/idle.cc`:

```
if (CheckIdleStateIsLocked()) return LOCKED;
if (CalculateIdleTime() >= threshold) return IDLE;   // >=, not >
return ACTIVE;
```

`Unknown` is never produced by `CalculateIdleState`.

**How "locked" is detected per OS**

* **macOS** (`idle_mac.mm`): `screensaverRunning || screenLocked`, two bools flipped by
  `NSDistributedNotificationCenter` notifications `com.apple.screensaver.didstart` / `.didstop`
  and `com.apple.screenIsLocked` / `.screenIsUnlocked`. The monitor only exists after
  `ui::InitIdleMonitor()`, which Electron calls at browser startup
  (`shell/browser/electron_browser_main_parts.cc`, found with `gh search code InitIdleMonitor`).
  So the state is blind to anything before launch (assumes unlocked) — same here: start a
  `PowerMonitor` at launch; it owns these two bits (`session.rs`).
* **Windows** (`idle_win.cc`, `ui/base/win/lock_state.cc`): `IsWorkstationLocked() ||
  IsScreensaverRunning()`. `IsWorkstationLocked` = initial `WTSQuerySessionInformation(WTSInfoEx)`
  `SessionFlags == WTS_SESSIONSTATE_LOCK`, then updated from `WM_WTSSESSION_CHANGE`
  (`UNLOCK` → false; `LOCK` for the current session → true). `IsScreensaverRunning` is a live
  `SystemParametersInfo(SPI_GETSCREENSAVERRUNNING)` on every call in 130 (newer Chromium caches it).

## 3. Power events — `powerMonitor` as `power.ts` uses it

`legacy/agent/src/main/services/power.ts` and `shift/index.ts` use: `suspend`, `resume`,
`lock-screen`, `unlock-screen`, `shutdown`. (`before-quit` / `before-quit-for-update` are app events,
not power events, and out of scope here.)

### macOS

| Electron event | Source |
|---|---|
| `suspend` / `resume` | **Chromium `base::PowerMonitor`**, not NSWorkspace: `base/power_monitor/power_monitor_device_source_mac.mm` ([link](https://github.com/chromium/chromium/blob/130.0.6723.118/base/power_monitor/power_monitor_device_source_mac.mm)) — `IORegisterForSystemPower`; `kIOMessageSystemWillSleep` → suspend; `kIOMessageSystemWillPowerOn` → resume; `kIOMessageCanSystemSleep` and `WillSleep` are acknowledged with `IOAllowPowerChange` (else sleep stalls up to 30 s). De-duplicated by `base/power_monitor/power_monitor.cc` (`NotifySuspend` only if not suspended, `NotifyResume` only if suspended). Electron's `PowerMonitor::OnSuspend/OnResume` emit the JS events. |
| `suspend` / `resume` (second path) | Electron 33's `electron_api_power_monitor_mac.mm` ([link](https://github.com/electron/electron/blob/v33.2.0/shell/browser/api/electron_api_power_monitor_mac.mm)) *also* observes `NSWorkspaceWillSleepNotification` / `NSWorkspaceDidWakeNotification`, but registers them on `NSDistributedNotificationCenter` — those notifications are posted on the *workspace* centre, so this path very likely never fires (removed in newer Electron). **Not reproduced**; if it ever fired legacy would see duplicates, which its handlers tolerate (`markAway` returns if away; `markBack` has a 1 s de-dup). |
| `lock-screen` / `unlock-screen` | Same file: `NSDistributedNotificationCenter` `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`. |
| `shutdown` | `shell/browser/mac/electron_application_delegate.mm` ([link](https://github.com/electron/electron/blob/v33.2.0/shell/browser/mac/electron_application_delegate.mm): observer for `NSWorkspaceWillPowerOffNotification` on the workspace centre) → `electron_application.mm` `willPowerOff:` runs the shutdown handler `PowerMonitor::ShouldShutdown`, which emits `shutdown` (wired for macOS only: `#if BUILDFLAG(IS_MAC)` in `electron_api_power_monitor.cc` @ v33.2.0). The notification is posted for shutdown, restart **and log out**; `preventDefault()` makes Electron skip its own quit. We emit `Shutdown` on the same notification; quitting is the caller's job. |
| `user-did-become-active` / `resign-active` | Emitted by Electron (`NSWorkspaceSessionDid…Notification`) but **not used by legacy** — not implemented. |

### Windows

`shell/browser/api/electron_api_power_monitor_win.cc` @ v33.2.0
([link](https://github.com/electron/electron/blob/v33.2.0/shell/browser/api/electron_api_power_monitor_win.cc)):
a hidden **message-only window** (`HWND_MESSAGE`, class `Electron_PowerMonitorHostWindow`),
`WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)` and
`RegisterSuspendResumeNotification(window, DEVICE_NOTIFY_WINDOW_HANDLE)` (needed for Modern Standby).

| Event | Message |
|---|---|
| `suspend` | `WM_POWERBROADCAST`, `wParam == PBT_APMSUSPEND` |
| `resume` | `WM_POWERBROADCAST`, `wParam == PBT_APMRESUMEAUTOMATIC` (not `PBT_APMRESUMESUSPEND`: Chromium notes it always follows) |
| `lock-screen` / `unlock-screen` | `WM_WTSSESSION_CHANGE`, `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`, only if `lParam` equals the process's session id (`ProcessIdToSessionId`; if that fails, assumed current) |
| `shutdown` | **Electron 33 emits none on Windows**: the shutdown handler is only installed under `#if BUILDFLAG(IS_MAC)` (and Linux via `setListeningForShutdown`) in `electron_api_power_monitor.cc` @ v33.2.0, and the Windows file has no `WM_ENDSESSION`/`WM_QUERYENDSESSION` handling. Legacy's `shutdown` handler is therefore dead on Windows. |

Chromium's own `PowerMessageWindow` (`power_monitor_device_source_win.cc`) listens to the same
two `PBT_` codes and emits through `base::PowerMonitor` (de-duplicated), so legacy on Windows
effectively sees each suspend/resume **twice**. We emit once; legacy's handlers are idempotent.

No additions on Windows: **no `Shutdown` is emitted**, as in Electron 33. A `HWND_MESSAGE` window
never receives `WM_QUERYENDSESSION` / `WM_ENDSESSION` (message-only windows get no broadcasts), so
an earlier superset claim was removed rather than kept unreachable. Windows session end is handled
at the app layer — the Tauri app's top-level window gets `WM_ENDSESSION`; that is wired there, later.
(When it is: emit at `WM_ENDSESSION` with `wParam != 0`, not at `WM_QUERYENDSESSION`, which another app
can still cancel.)

Startup: `WTSRegisterSessionNotification` can fail with `RPC_S_INVALID_BINDING` at logon before RPC is
ready. Chromium/Electron ignore the failure; we do not: bounded backoff on that one error (≈ 7.75 s),
then `Err` with full teardown, so a monitor that cannot see locks is never reported as started.
Unregistration runs on the owner thread **before** `DestroyWindow`, as Microsoft requires.

## 4. Permissions

* `systemPreferences.isTrustedAccessibilityClient(prompt)` — `electron_api_system_preferences_mac.mm`
  ([link](https://github.com/electron/electron/blob/v33.2.0/shell/browser/api/electron_api_system_preferences_mac.mm)):
  `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: prompt})`. → `permissions::accessibility_trusted`.
  Windows/Linux in legacy (`permissions.ts`): `true`.
* `systemPreferences.getMediaAccessStatus('screen')` — same file → `ConvertSystemPermission(
  system_permission_settings::CheckSystemScreenCapturePermission())`. In Chromium 130
  (`chrome/browser/permissions/system/system_media_capture_permissions_mac.mm`,
  [link](https://github.com/chromium/chromium/blob/130.0.6723.118/chrome/browser/permissions/system/system_media_capture_permissions_mac.mm))
  that is `IsScreenCaptureAllowed() ? kAllowed : kDenied`, with `IsScreenCaptureAllowed` =
  `ui::IsScreenCaptureAllowed()` = **`CGPreflightScreenCaptureAccess()`** (`ui/base/cocoa/permissions_utils.mm`)
  behind feature `MacSystemScreenCapturePermissionCheck`, which is **enabled by default** in 130
  (`chrome/common/chrome_features.cc`). `ConvertSystemPermission`: kAllowed → `"granted"`,
  kDenied → `"denied"`. So on this Electron the status is only ever `granted` or `denied`;
  `not-determined` / `restricted` (which legacy's `screenUiState` handles) cannot occur.
  Staleness after a toggle (electron#36722, cited in `permissions.ts`) is inherent to the
  preflight call and carries over.
* Input Monitoring: Electron has **no** API (legacy comments say so). We expose
  `CGPreflightListenEventAccess` / `CGRequestListenEventAccess` (same calls Airnote uses) but the
  input listener does **not** gate on them: like libuiohook it gates on Accessibility (§5).
* Settings URLs: exactly the strings in `legacy/agent/src/main/ipc/settings.ts`
  (`Privacy_ScreenCapture`, `Privacy_ListenEvent`, `Privacy_Accessibility`,
  `com.apple.LoginItems-Settings.extension`, and `ms-settings:startupapps` — legacy's only
  Windows opener). `shell.openExternal` = `open <url>` on macOS, `ShellExecuteW("open", url)` on Windows.

## 5. Input counting — `uiohook-napi` → what `activity/index.ts` counts

`activity/index.ts` subscribes to `keydown`, `mousedown`, `wheel`, `mousemove`.
`uiohook-napi` `src/lib/addon.c`: `EVENT_MOUSE_DRAGGED` is rewritten to `EVENT_MOUSE_MOVED`;
`dist/index.js` maps `KEY_PRESSED→keydown`, `MOUSE_PRESSED→mousedown`, `MOUSE_MOVED→mousemove`,
`MOUSE_WHEEL→wheel`. Coordinates are libuiohook's `int16_t`. Legacy applies a 50 ms move
throttle itself (`MOVE_THROTTLE_MS`; `input::MoveThrottle`).

**macOS** (`libuiohook/src/darwin/input_hook.c`, `input_helper.c`): `hook_run` first checks
`is_accessibility_enabled()` (`AXIsProcessTrustedWithOptions`; legacy calls `hasAccessibilityAccess(false)`
before `uIOhook.start()`), then creates an **active** tap — `kCGSessionEventTap` /
`kCGHeadInsertEventTap` / `kCGEventTapOptionDefault` — with the mask KeyDown, KeyUp, FlagsChanged,
{Left,Right,Other}Mouse{Down,Up,Dragged}, MouseMoved, ScrollWheel, `NX_SYSDEFINED`, on its own run loop;
`kCGEventTapDisabledByTimeout` → `CGEventTapEnable(true)`. `input::mac` reproduces all of that and
reports `Granted` only after the Accessibility gate; a non-null tap is not treated as proof.

* key pressed: `kCGEventKeyDown` (auto-repeat included); `kCGEventFlagsChanged` for the 8 modifier
  keys when the matching flag bit is set; `NX_SYSDEFINED` subtype 8, key-down, for `NX_KEYTYPE_` 0,1,4,7,14,16,**19,20**
  (sound up/down, caps, mute, eject, play, fast, rewind — *not* next/previous 17/18, not brightness).
  `subtype`/`data1` come from `NSEvent` (`USE_OBJC` is defined in `binding.gyp`).
* mouse pressed: left, right and other-button **down**, and — a libuiohook bug — other-button **up** (the switch calls `process_button_pressed`).
* mouse move: `MouseMoved` and all three `…Dragged`; `CGEventGetLocation` into an `int16_t`.
* wheel: `kCGEventScrollWheel` if `DeltaAxis1 != 0 || DeltaAxis2 != 0`, one event per OS event.

**Windows** (`libuiohook/src/windows/input_hook.c`): `SetWindowsHookEx(WH_KEYBOARD_LL)` + `WH_MOUSE_LL`
on one thread with `GetMessage` loop (stopped by `PostThreadMessage(WM_QUIT)`).

* key: `WM_KEYDOWN`/`WM_SYSKEYDOWN` (repeats and injected keys included).
* mouse down: `L/R/M/X BUTTONDOWN` (and `NCXBUTTONDOWN`).
* move: `WM_MOUSEMOVE`, **dropped when the point equals `last_click`** (a zero-initialised *file-level static*, set on every press, never reset by hook stop/start — ours is process-static too: `decide::decode_win_mouse`); coordinates `(int16_t)` wrapped.
* wheel: `WM_MOUSEWHEEL` and `WM_MOUSEHWHEEL`, one each.

All of the above is encoded in `src/input/decide.rs` as pure functions with unit tests, and the
macOS half was checked live against the real `uiohook-napi` (see the report / `PARITY.md`).

## 6. Screen capture — `desktopCapturer.getSources` as `capture.ts` uses it

`capture.ts::captureNow` calls `desktopCapturer.getSources({ types: ['screen'], thumbnailSize:
{ 2560, 2560 } })`, then sharp. Everything below was read from Electron **33.2.0** / Chromium
**130.0.6723.118** (WebRTC rev `28b793b4`), and the sizes and ids were then **measured** by running
that exact Electron on this Mac (`display_id "1"`, `screen:1:0`, thumbnail 2560×1655 for a
3456×2234-pixel panel).

### macOS — which API, and why it is `CGDisplayCreateImage`

| Step | Source |
|---|---|
| `getSources` → `MakeScreenCapturer()` | `shell/browser/api/electron_api_desktop_capturer.cc` @ v33.2.0: `ShouldUseThumbnailCapturerMac(kScreen)`, else `content::desktop_capture::CreateScreenCapturer()` |
| ScreenCaptureKit is **off** | `chrome/browser/media/webrtc/thumbnail_capturer_mac.mm` @ 130.0.6723.118: `ShouldUseThumbnailCapturerMac` is `ShouldUseSCContentSharingPicker() \|\| IsEnabled(kScreenCaptureKitPickerScreen)`; `kScreenCaptureKitPickerScreen`, `…StreamPickerSonoma`, `…StreamPickerVentura` are all `FEATURE_DISABLED_BY_DEFAULT` there, and `media::kUseSCContentSharingPicker` (`media/base/media_switches.cc`) is also `DISABLED_BY_DEFAULT` |
| → WebRTC `ScreenCapturerMac` | `modules/desktop_capture/mac/screen_capturer_mac.mm` (`CgBlit`) @ `28b793b4` |
| IOSurface / `CGDisplayStream` is **off** on macOS ≥ 14 | `content/public/browser/desktop_capture.cc`: `CGDisplayStreamCreateIsAvailable()` is false from 14 unless `UseCGDisplayStreamCreateSonoma`, which is disabled by default |
| → `DesktopFrameProvider::TakeLatestFrameForDisplay` | `mac/desktop_frame_provider.mm` → `DesktopFrameCGImage::CreateForDisplay` → **`CGDisplayCreateImage(display_id)`** (`mac/desktop_frame_cgimage.mm`) |

So legacy captures with `CGDisplayCreateImage`, per display, at native pixel size, under the
`kTCCServiceScreenCapture` grant. That is what is kept:

* **Same API, same TCC service ⇒ no extra prompt compared with legacy** on macOS 14, 15 and 26.
* `CGDisplayCreateImage` is deprecated since macOS 14 and *obsoleted* (a compile error against the
  macOS 15 SDK, though the framework still exports it and it still works; the
  [VLC](https://mailman.videolan.org/pipermail/vlc-commits/2026-April/072878.html) and
  [MacPorts](https://trac.macports.org/ticket/70709) threads show the same). **Verified here on macOS
  26.6.2: it returns a real 3456×2234 image** (`examples/capture_probe.rs`).
* It is looked up with `dlsym`, not linked (`capture/mac_sys.rs`). If Apple ever deletes the symbol,
  Timo still launches, capture reports an error, and health becomes `error`. The migration path is
  `SCScreenshotManager.captureImage(contentFilter:configuration:)` (macOS 14+). It is **not**
  implemented: it needs a second code path (async `SCShareableContent` plus a block), and it does not
  avoid the macOS 15 re-consent prompt (below), so it buys nothing today.
* **Re-consent (macOS 15+).** Sequoia asks users, about monthly, to re-approve any app that captures the
  screen outside the system content picker; it applies to the deprecated `CGWindowListCreateImage` /
  `CGDisplayStream` family and, per reports, to ScreenCaptureKit used without the picker
  ([9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/),
  [Michael Tsai](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/),
  [Apple forums](https://developer.apple.com/forums/thread/761443)). Legacy has the same exposure, so this is
  not a regression; nothing in the OS lets an app opt out, and the grant check stays
  `CGPreflightScreenCaptureAccess` as in §4. I did not observe the prompt (it is weeks apart); that is
  from the sources.
* **Pixel format.** `CGImage` data is 32-bit little-endian words with alpha (or a skipped byte) first, so
  B, G, R, A in memory, rows padded to `bytesPerRow`. Chromium assumes that after checking only
  `bitsPerPixel == 32`; here the byte order, alpha position and 8-bit components are checked too, and
  anything else is a *blank capture*, not noise (an HDR half-float image would be). The pixels are in
  the display's colour space and are **not** converted to sRGB, exactly like legacy (a Display-P3 panel
  therefore stores slightly under-saturated sRGB-tagged-by-default values).
* **Display set and order.** `CGGetActiveDisplayList` (one entry per mirror set), main display first, which
  is the `[NSScreen screens]` order Chromium lists. `displayId` = the `CGDirectDisplayID` in decimal
  (`source.display_id = NumberToString(media_list_source.id.id)`, never empty on macOS).

### Windows — GDI, per monitor

Electron 33 on Windows prefers DXGI Desktop Duplication (`kDirectXCapturer` is enabled by default) and
falls back to GDI (`electron_api_desktop_capturer.cc`: `allow_directx_capturer()`; Chromium's own
comment says it is kept "to force fallback to GDI"). **GDI only** is ported:

* no D3D device, no duplication session to lose on a mode change, lock screen or UAC prompt, no
  per-process duplication limit; the screen DC has held the DWM-composed desktop since Windows 8, so
  the picture is the same. What DXGI adds is speed and the cursor, which a screenshot does not need.
* One `CreateDCW("DISPLAY", "\\.\DISPLAYn")` per monitor from `EnumDisplayDevices` (attached to the
  desktop, not mirroring drivers), at the physical size from `EnumDisplaySettings(ENUM_CURRENT_SETTINGS)`,
  `BitBlt(SRCCOPY | CAPTUREBLT)` into a compatible bitmap, `GetDIBits` as a top-down 32-bit `BI_RGB` DIB.
* The grabbing thread is switched to `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` for the call and put
  back, so mixed-scaling multi-monitor layouts come out in physical pixels even if the process is not
  itself DPI aware.
* `displayId`: Electron's DXGI path sets `display_id` to `DisplayInfo::DisplayIdFromMonitorInfo`
  (`ui/display/win/display_info.cc`): `base::PersistentHash("%lu/%li/%u")` of the display-config path's
  adapter LUID (low, high) and target id (from `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo`
  matching the source's GDI name), falling back to `PersistentHash(<GDI device name>)`.
  `PersistentHash` is `SuperFastHash` (`base/hash/hash.cc`); the port is checked against Chromium's own C
  source compiled with `cc` (`parity/native/capture/superfasthash.sh`, 17 vectors incl. the
  `signed char` sign-extension cases). **Not run on Windows.**

### The thumbnail: Chromium resizes *before* sharp ever sees the pixels

`thumbnail.getSize()` is not the display's size. `NativeDesktopMediaList` (`ScaleDesktopFrame`, Chromium
130) scales the frame to the largest size that fits `thumbnailSize`, using
`media::ComputeLetterboxRegion` → `ScaleSizeToTarget(content, bounds, fit_within_target = true)`
(`media/base/video_util.cc`): the longer side is made equal to the box, the other is
`RoundedDivision`-ed, and **small frames are enlarged**. libyuv `ARGBScale(kFilterBilinear)` does the
scaling and alpha is forced to 255. Measured on this Mac: 3456×2234 → **2560×1655**. For a 1920×1080
monitor it is 2560×1440, an enlargement. Legacy's `width`/`height` are those numbers, and sharp's own
`resize(inside, withoutEnlargement)` is then a no-op. Both rules are in `capture/size.rs`.

### The encode: same libwebp, same settings

`sharp@0.33.5` bundles libvips 8.15.3 with libwebp **1.4.0**. `webp@0.3.1` vendors libwebp-sys 0.9.6
whose `WEBP_ENCODER_ABI_VERSION` is `0x020f`, i.e. libwebp **1.4.0** as well. Driven with quality 82,
`method` 4 (sharp's default `effort`), RGB in, no alpha, no sharp-YUV, **the bytes are identical to
sharp's whenever sharp does not resize** (4 of 7 frames in `tests/capture_parity.rs`). When it does
resize, libvips and `fast_image_resize` use different Lanczos3 implementations and the pixels differ by
a few levels (PSNR ≥ 47 dB, SSIM ≥ 0.997 on the fixtures).

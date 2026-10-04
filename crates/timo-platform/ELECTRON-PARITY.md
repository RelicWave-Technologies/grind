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

Our additions on Windows (superset, because the user asked for it and legacy otherwise never
cleans up on shutdown there): `WM_QUERYENDSESSION` is answered `TRUE` (never veto), and
`WM_ENDSESSION` with `wParam != 0` emits `Shutdown`. We deliberately do **not** emit at
`WM_QUERYENDSESSION`: another app can cancel the shutdown after that, and stopping a timer for a
shutdown that did not happen would under-bill.

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
* Input Monitoring: Electron has **no** API (legacy comments say so). We add
  `CGPreflightListenEventAccess` / `CGRequestListenEventAccess` (same calls Airnote uses).
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

**macOS** (`libuiohook/src/darwin/input_hook.c`): active `kCGSessionEventTap` /
`kCGHeadInsertEventTap`, `kCGEventTapOptionDefault` (hence legacy needs Accessibility), run on its own
run loop; `kCGEventTapDisabledByTimeout` → `CGEventTapEnable(true)`.

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
* move: `WM_MOUSEMOVE`, **dropped when the point equals `last_click`** (a zero-initialised static, set on every press); coordinates `(int16_t)` wrapped.
* wheel: `WM_MOUSEWHEEL` and `WM_MOUSEHWHEEL`, one each.

All of the above is encoded in `src/input/decide.rs` as pure functions with unit tests, and the
macOS half was checked live against the real `uiohook-napi` (see the report / `PARITY.md`).

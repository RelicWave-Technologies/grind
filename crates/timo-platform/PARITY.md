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
5. **Windows: a pointer move to exactly the last click point is dropped**; the initial "last click" is (0,0).
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
| macOS tap | active tap (needs Accessibility) | **listen-only** tap (needs Input Monitoring) | task brief; a tap that cannot modify events is the least privilege. The *events* are identical. Gating that legacy does on `isTrustedAccessibilityClient` must become an Input Monitoring check in the app layer. |
| macOS suspend/resume source | IOKit via Chromium (+ a dead NSWorkspace-on-distributed-centre path) | IOKit only, de-duplicated identically | the dead path never fires |
| Windows suspend/resume | emitted twice (Electron window + Chromium window) | emitted once | legacy handlers are idempotent |
| Windows `shutdown` | not emitted | `WM_ENDSESSION(TRUE)` → `Shutdown` | superset; legacy's `shutdown` handler is dead on Windows |
| Event delivery | N-API threadsafe function, unbounded | bounded 4 096-event queue + dispatcher thread; overflow is counted in `InputStatus::dropped_events` | keeps the OS hook fast; a stuck sink cannot grow memory without bound |
| One listener per process | n/a | enforced (`AlreadyRunning`) | Windows hook procs have no user-data slot |
| Windows wheel when `SystemParametersInfo` fails | event ignored | counted | libuiohook ignores the event if that call fails; it does not fail in practice |

## Open / unproven

See the report: nothing here has run on real Windows; macOS lock/unlock/sleep/wake/power-off
delivery is by construction and source reading, not observed.

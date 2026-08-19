# ADR-0001 — Overlay visibility cannot be observed, so nothing may depend on it

- **Status:** accepted
- **Date:** 2026-08-18
- **Applies to:** every **Overlay** in the desktop agent, and every caller that gates behaviour on a **Prompt** being active

## Context

An overlay that is shown is not necessarily an overlay that is seen, and on
macOS the agent has **no way to tell the difference**.

`NSWindowCollectionBehaviorCanJoinAllSpaces` applies only to Spaces that
already existed when it was set. Sleeping the machine, or entering a full-screen
app, creates a **new** Space that the window never joins. Nothing is dropped —
the flag stays set, and the window stays "visible" — it is simply parked
somewhere the person is not looking. Apple's prescribed remedy is to observe
`NSWorkspaceActiveSpaceDidChangeNotification` and call `makeKeyAndOrderFront:`,
which is why clicking the app appears to fix it: that click *is* the remedy.

That notification is native AppKit. **Electron does not expose it.**

Electron also cannot report the condition. `win.isVisible()` and
`win.isAlwaysOnTop()` are Electron's own bookkeeping and both stay `true`
throughout. A field log from 2026-08-18 records
`attention float state {"floating":true,"visible":true,"alwaysOnTop":true}`
during a period when the person could see nothing at all.

[electron#36364][1] describes exactly this symptom — *"not working unless the
window is manually focused by user"* — and is **closed as not planned**. Its
reporter confirmed `show()`, `focus()` and `moveTop()` are all ineffective.

Before this ADR, six changes had attacked the symptom (`beta.29` and `beta.30`
overlay lifecycle, `b8fa826`, `35ae1b5`, `f52889b`, and the earlier float
re-assertions). Each re-applied a flag that was never lost.

## Decision

1. **No module may treat "shown" as "seen."** An overlay being placed, raised,
   or reported on top is not evidence that anyone can see it.

2. **No user-facing route into the app may be gated on a Prompt being active.**
   A prompt outranks the main window in *presentation*, never in *reachability*.
   Specifically, the tray popover is never refused: it is the control people
   fall back on when a window has gone missing.

3. **Unreachability is inferred behaviourally, not detected.** A second request
   for the app arriving within `PROMPT_UNREACHABLE_WINDOW_MS` of re-presenting a
   prompt means the re-present did nothing. The prompt is released and the
   person is let in. The rule lives in `services/promptReachability.ts` as a
   pure decision over durations so it can be tested without a display.

4. **Every prompt transition is logged** — shown, restored, cleared, released —
   with the float belief attached. Without this the degraded path is invisible
   in the field, which is how the original fault survived four days of logs.

## Consequences

- A person can always reach the app. Worst case they answer one prompt fewer.
- We accept a false positive: someone who deliberately clicks the app twice in
  twelve seconds while a prompt is genuinely up will dismiss it. That is a
  strictly better failure than an app that cannot be opened at all.
- `ShiftMonitor` still suppresses the untracked nudge while any prompt is
  active (`services/shift/index.ts`, `attentionBusy`). A stranded prompt
  therefore also suppresses that nudge until it is released. Known and accepted;
  it is a missing reminder, not a deadlock.
- Full reliability still requires the native notification in decision 1's
  context — a native module, with build, signing and notarisation cost on both
  architectures. **It remains unbuilt on purpose**, and it would not remove the
  need for the rules above: a native hook can fail too, and the app must degrade
  rather than deadlock when it does. Revisit when the
  `attention prompt released as unreachable` log line shows how often the
  degraded path actually fires.

## Amendment (2026-08-19) — the process transition must stay suppressed

`setVisibleOnAllWorkspaces` toggles the macOS process type to UIElement and back
while it configures Spaces. `skipTransformProcessType: true` suppresses that, and
it is **required**.

This has now been round-tripped twice, so the loop is recorded here to stop a
third pass:

1. `3a78ab5` (22 Jul) let the transition run and called
   `ensureRegularMacApplication()` afterwards to restore the Dock identity.
2. `b8fa826` (15 Aug) added `skipTransformProcessType: true` **because that
   produced stale Dock tiles** — but deleted the rationale, leaving the identity
   call looking vestigial.
3. beta.35 restored the transition on the theory that suppressing it was why
   all-Spaces membership did not survive a newly-created Space. **Five stacked
   Timo tiles appeared in the Dock within minutes.** Theory refuted, reverted.

The tell that made this loop possible: `ensureRegularMacApplication()` exists
only to undo the transition, so once the transition is suppressed it looks
pointless. It is not — it is the safety net if the flag is ever dropped again.
Leave it at boot and leave the flag on.

Stranding is addressed instead by **never letting a prompt surface outlive the
Spaces it joined**. A hidden window keeps whatever membership it had when built,
so `attentionHost.hide()` destroys rather than hides and the next prompt is built
in front of whoever is looking. That change is unaffected by this revert and
stays.

## Do not re-suggest

Raising harder. `focus()`, `moveTop()`, `show()`, re-applying
`setAlwaysOnTop`, or re-applying `setVisibleOnAllWorkspaces` on a timer are all
attempts to fix a condition the platform will not report and Electron will not
expose. They have been tried.

[1]: https://github.com/electron/electron/issues/36364

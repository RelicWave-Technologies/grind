# Timo

Internal time tracker: a desktop agent that records worked time, screenshots and
input activity, an API that owns the authoritative record, and a dashboard for
reviewing it. This file names the concepts the code is built around, so the same
word means the same thing in a comment, a module name and a conversation.

## Language

### Attention surfaces

**Prompt**:
A surface asking the person a question they must answer before tracking can
continue — idle, away, or permissions. Exactly one is active at a time.
_Avoid_: popup, modal, dialog, notification

**Overlay**:
Any frameless always-on-top window the agent puts over other applications. Every
overlay is a non-activating panel on macOS and never activates the app.
_Avoid_: floating window, widget

**Ambient overlay**:
An overlay that reports rather than asks — the timer bar, the tray popover, the
shift toast. Distinguished from a Prompt because it must never bury one.
_Avoid_: chrome, furniture, HUD

**Rank**:
An overlay's precedence against other overlays. `prompt` outranks `ambient`.
Enforced by window level on macOS and by suppressing ambient raises everywhere,
because Windows collapses all always-on-top levels into one band.
_Avoid_: z-index, layer, priority

**Hold**:
Keeping a prompt on top as a maintained invariant — checking whether it is still
on top and re-raising only when it is observably not. Distinct from re-raising on
a timer or on an event, which cannot tell whether it worked.
_Avoid_: reassert, retry, pin

**Suspension**:
A hold deliberately paused with a condition for resuming, used when the person is
in System Settings. The prompt returns on its own when the condition is met.
_Avoid_: yield, dismiss, defer

**Reachable**:
Whether the person can actually answer a prompt. Distinct from whether it was
shown: macOS can hold an overlay on a Space we are never told about, so a prompt
can be active, on top, and unreachable at the same time. Not observable — it is
inferred from behaviour (asking for the app again straight after a restore).
_Avoid_: visible, shown, displayed

**Float belief**:
What the app thinks about an overlay's float — `isVisible() && isAlwaysOnTop()`.
Electron's own bookkeeping, and true even when the window is parked on another
Space. Logged as evidence of what we believed, never as proof anyone saw it.
_Avoid_: visibility, is-showing

**Overlay host**:
The seam between a prompt's presentation policy and the windowing system.
Satisfied by a real Electron adapter and by a fake in tests, which is what makes
"is the prompt on top?" something a test can control.
_Avoid_: presenter, window manager, renderer

### Tracking

**Time entry**:
One continuous tracked session, made of segments. The agent owns an open entry;
the API owns the authoritative record of closed ones.
_Avoid_: session, timesheet row, log

**Segment**:
A span within a time entry with a single kind (work, meeting, idle-trimmed).
Pausing closes the open segment; resuming opens a new one.
_Avoid_: interval, block, chunk

**Capability**:
Something the OS must grant before tracking can accrue — screen recording, input
monitoring. Reported as a state, never as a bare boolean, because "not yet
checked" is not the same as "denied".
_Avoid_: permission (the OS grant), feature

**Readiness**:
Whether every required capability is currently satisfied. The gate the timer
consults before accruing time.
_Avoid_: health, status

**Lease**:
The server-side window during which an open time entry is considered still alive.
Renewed by the agent's heartbeat; expiry closes the entry server-side.
_Avoid_: keepalive, TTL

### Time

**Frame**:
Which clock an instant was read from — the device's or the server-aligned one.
Two instants are only comparable within the same frame. Instants from different
frames look identical in the type system and are not.
_Avoid_: timezone (unrelated), clock source

**Server-aligned clock**:
The agent's clock for anything the server will judge. Anchored to a known server
instant and advanced by a monotonic source, so it cannot freeze, run backwards,
or be moved by editing the device clock.
_Avoid_: corrected clock, NTP time

**Elapsed**:
A duration rather than an instant. Frame-free — "idle for 300s" means the same
on any clock — which is why the timer's interface takes elapsed time and never a
timestamp.
_Avoid_: since, at, timestamp

### Time off

**Working day**:
A date a person was expected to work, according to the shift assignment in
force that date. Everything else — a weekly off, a company holiday, approved
leave — is an absence measured against it.
_Avoid_: workday, business day

**Working Calendar**:
The module that answers "was this person expected to work on this date, and if
not, why". It owns the precedence between shift, holiday and leave, so the same
question cannot get four different answers in attendance, reports, payroll and
the request quote.
_Avoid_: schedule, roster

**Day**:
The unit every leave amount is measured in — a decimal on the 0.5 grid. Accrual,
consumption, balance, adjustment and every report column use it, so nothing
converts. Halves are exact in binary floating point, and the company's Lark
leave approval already emits the same "0.5" and "1".
_Avoid_: hours, half-days-as-a-count, minutes

**Portion**:
Which part of a day an absence covers — `FULL`, `FIRST_HALF`, `SECOND_HALF`.
Worth 0.5 or 1 to the balance, where the half does not matter; load-bearing
everywhere else, because it sets the window work is still expected in. Lark
encodes the same thing as AM/PM on the leave form.
_Avoid_: half day (ambiguous — which half?)

**Charged**:
The balance a day draws down. Distinct from **paid**: a company holiday and a
weekly off are charged 0.0, and unpaid leave is charged 0.0 because it costs no
money. Nobody is charged for a day they were never expected to work.
_Avoid_: deducted, used (they hide the paid/charged distinction)

**Ledger**:
The append-only list of accrual, consumption and adjustment entries. The balance
is their sum, never a stored counter — which is what makes a replayed approval a
no-op, a cancellation a visible reversal, and carry-forward something that needs
no code because nothing resets.
_Avoid_: balance table, quota

**Source key**:
The idempotency key on a ledger entry — `accrual:<userId>:<YYYY-MM>`,
`leave:<requestId>`, `leave-reversal:<requestId>`. Unique, so writing the same
fact twice loses rather than double-counting, and a missed accrual month can be
backfilled correctly dated.
_Avoid_: dedupe key, external id

**Approval gateway**:
The seam a leave request goes through to be decided. Satisfied by a Lark adapter
(the company's existing approval bot card owns the decision) and a dashboard
adapter (Timo owns it). Callers ask the gateway whether Timo may record a
decision rather than branching on which one is configured.
_Avoid_: approver, workflow

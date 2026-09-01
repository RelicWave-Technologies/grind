# Month Performance Report — every calculation, in order

The monthly attendance grid, downloadable as CSV and `.xlsx` from
**Reports → Team** and **Attendance**.

This document traces every figure back to the line that produces it. It is
written against the code, not from memory. If you change a rule, change this in
the same commit.

---

## 1. The request

| | |
|---|---|
| `GET /v1/reports/month-performance.csv` | CSV, one block per person |
| `GET /v1/reports/month-performance.xlsx` | Workbook: grid, Summary, Legend |
| `?month=YYYY-MM` | Defaults to the current month **in the workspace timezone** |
| Permission | `reports.team.read` |
| People | `req.scope.userIds` — manager sees their team, admin the workspace |

### The column axis

`monthDates(month)` enumerates the month:

```
last = new Date(Date.UTC(y, m, 0)).getUTCDate()   // day 0 of next month = last of this
dates = ['YYYY-MM-01' … 'YYYY-MM-last']
```

Derived from the month, never from the data. An empty report still has 31
columns. Users are sorted by name, then email.

---

## 2. What is loaded

Three reads, in parallel.

### 2.1 The Working Calendar

`timesheetCalendarInputs()` loads, for the month:

- **Shift assignments** per user — `shiftId`, `effectiveFrom`, `effectiveTo`,
  `shiftNameSnapshot`, `scheduleSnapshot`
- **Company holidays** — date, name, `teamId` (null = whole workspace)
- **Approved leave** — `LeaveRequest` with `status = APPROVED`, its `portion`
  and `kind`
- **Per-person last-Saturday-off** — `user.lastSaturdayOffOverride`, falling
  back to `policy.lastSaturdayOff`
- **Team membership**, for team-scoped holidays

### 2.2 Punches

`loadPunchLookup()` reads `AttendancePunch` for the month, keyed
`(userId, date)`.

`punchInAt` / `punchOutAt` are `TIME` columns — a clock reading, not an instant.
Prisma returns them as a Date whose date part is the epoch. The minute is read
with **UTC accessors on purpose**:

```
minute = value.getUTCHours() * 60 + value.getUTCMinutes()
```

There is no timezone to apply. `09:34` is what the machine saw on the wall.

### 2.3 Time entries

```
lookbackStart = localDayWindow(from).start − 24h
lookbackEnd   = localDayWindow(to).end   + 24h
```

Entries are fetched with `startedAt < lookbackEnd` and
`(endedAt IS NULL OR endedAt > lookbackStart)`. The extra day on each side is
not slack: an entry crossing local midnight belongs partly to a day inside the
month, and a query bounded exactly at the month's edges would drop it.

Time invalidations are fetched over the same widened window.

---

## 3. Total Working Hours

### 3.1 Closing an open segment

A segment with no `endedAt` still has to end somewhere.
`resolveEffectiveEntrySegmentEnds()` decides, per segment:

1. **`endedAt` present** → use it.
2. **A later segment starts, or the entry itself ended** → end at whichever
   comes first, never before this segment's own start.
3. Otherwise `resolveEffectiveSegmentEnd()`:

| Condition | End |
|---|---|
| Protocol v2, lease still valid (`leaseExpiresAt > now`) | `null` → the caller uses **now** |
| Protocol v2, lease expired | `min(now, max(start, lastProvenAt))` |
| Legacy, heartbeat fresh for this entry | `null` → **now** |
| Legacy, stored proof ≥ start | `min(latestStoredProof, now)` |
| Legacy, heartbeat ≥ start | `min(latestHeartbeat, now)` |

This is why a day can stop mid-afternoon: when the agent goes away the lease
expires and the entry closes at the **last proven moment**, not at the moment
the person actually stopped.

### 3.2 Resolving overlaps

`resolveSegmentOverlapsPerUser()` runs per person — two people working the same
hour is not a conflict.

```
CLAIM_PRIORITY = { tracked: 2, manual: 1, idle: 0 }
```

`resolveOverlaps()` sorts by **priority descending**, then `startedAt` ascending,
then `endedAt` descending. Walking that order, each item contributes only the
parts no earlier item has claimed.

So for one person, on the same instant:

**tracked (AUTO work or meeting) beats manual, and manual beats idle-trimmed.**
Approved manual time fills only the gaps live tracking did not already cover.

### 3.3 Bucketing into days

For each surviving segment:

- **`IDLE_TRIMMED` is skipped entirely.** It is not worked time — that is the
  whole point of the trim. It takes part in overlap resolution (so it can be
  carved away by tracked time) and is then dropped.
- The segment is clipped to each **local day window** it touches, in the
  workspace timezone. A segment across local midnight is split.
- `subtractInvalidations()` removes any stretch an admin has struck out. The
  removed length lands in `invalidatedMs`; the surviving pieces are counted.
- Each surviving piece is added to one bucket **and** to `totalMs`:

| Bucket | When |
|---|---|
| `manualMs` | entry `source = MANUAL` |
| `meetingMs` | `segmentKind = MEETING` |
| `workedMs` | everything else |

### 3.4 The number in the cell

```
trackedMinutes = round(cell.totalMs / 60_000)
workMinutes    = max(0, round(trackedMinutes))
```

`totalMs` is **work + meeting + approved manual**, after idle removal, after
invalidation removal, after overlap resolution, clipped to the local day.

This is **not** the gap between the two punches. Badge 09:00–18:00 with three
hours recorded shows `03:00`.

---

## 4. Office In / Office Out

`fmtClock(minute)`:

```
null  → '--:--'
else  → pad2(floor(m / 60)) : pad2(m % 60)
```

Shown exactly as recorded, never inferred. `--:--` means no punch was recorded
— a fact. Printing `00:00` would be a different and false one. A punch in with
no punch out is normal and is shown that way.

---

## 5. Status

Two stages. The calendar answers first; only if it has nothing to say do the
hours decide.

### 5.1 What the calendar answers

`WorkingCalendar.dayStatus(userId, date)` runs these in order and returns at
the first match.

**First, which shift applies** (`resolveShiftForDay`):

1. No assignments for this person → `NO_SHIFT`
2. Assignments overlapping the day are filtered, then the one with the **latest
   `effectiveFrom`** wins
3. That assignment has no `shiftId` → `NO_SHIFT`
4. Its `scheduleSnapshot` fails to parse → `NO_SHIFT`
5. The schedule has no entry for this weekday → `WEEKLY_OFF`
6. This person has last-Saturday-off **and** it is the last Saturday of the
   month → `WEEKLY_OFF`
7. Otherwise → working

**Then, in this exact order:**

| Order | Check | Result |
|---|---|---|
| 1 | no shift | `NO_SHIFT`, expectedFraction 0 |
| 2 | weekly off | `WEEKLY_OFF`, expectedFraction 0 |
| 3 | holiday on this date, for this team or workspace-wide | `HOLIDAY`, paid, charges 0 |
| 4 | approved leave covering this date | `PAID_LEAVE` / `UNPAID_LEAVE` |
| 5 | none of the above | `WORKING`, expectedFraction 1 |

**The order matters and is easy to get wrong:**

- A holiday falling on a **weekly off reads `WO`**, not `HL` — step 2 returns
  first. Nobody is credited a holiday on a day they were not working anyway.
- Leave on a **holiday reads `HL`** and costs no balance — step 3 returns
  before step 4. That is what stops a Mon–Fri leave request containing a
  holiday from charging five days instead of four.

**For leave**, with `portionDays(FULL) = 1` and `portionDays(FIRST_HALF | SECOND_HALF) = 0.5`:

```
away             = portionDays(portion)
chargedDays      = paid ? away : 0        // unpaid costs no balance
expectedFraction = 1 − away               // FULL → 0,  half → 0.5
```

`chargedDays` and `paid` are different columns. Unpaid leave is charged 0
because it costs no money, not because nobody was away.

### 5.2 What the hours answer

`codeForDay(status, trackedMinutes)`:

```
HOLIDAY                              → HL
WEEKLY_OFF                           → WO
PAID_LEAVE,   expectedFraction > 0   → HD      (half-day leave)
PAID_LEAVE,   expectedFraction = 0   → PL
UNPAID_LEAVE, expectedFraction > 0   → HD
UNPAID_LEAVE, expectedFraction = 0   → LWP
─────────────────────────────────────────────
trackedMinutes > 0                   → P
trackedMinutes = 0 and NO_SHIFT/none → --
otherwise                            → A
```

`expectedFraction > 0` is exactly "still expected to work part of the day",
which is what a half day is.

**There is no minimum.** One tracked minute reads `P`. A floor only decides
which side of an arbitrary line a real working day falls on, and the hours are
printed directly above — a reader can see six hours and judge six hours. The
status answers *did they work*; the hours answer *how much*.

An earlier version used an eight-hour floor. In this workspace that sat exactly
on the median tracked day, splitting the workforce roughly in half on
ten-minute differences and producing 743 half days in one month.

**`HD` is only ever half-day leave.** It is never inferred from hours.

**`--` is not absence.** With no shift assigned, Timo cannot say the person was
expected to be there, so it does not call them absent. It means *no opinion*,
and it is a sign somebody needs a shift assignment.

### 5.3 What is deliberately not used

The **payroll classifier**. Payroll applies two rules that are right for pay and
wrong for an attendance record:

- a **monthly guarantee** that upgrades every eligible day to a full day once
  the month total clears a floor, and
- a **carry allocator** that moves surplus tracked time from one day onto a
  thinner one.

Under those, a day with two tracked hours can read as a full day. Every day
here is judged on that day's own tracked time and nothing else.

---

## 6. Totals

Each day increments exactly one counter, so the seven code counts always sum to
the length of the month.

| Field | Counts |
|---|---|
| Present | `P` |
| Half Day | `HD` |
| Weekly Off | `WO` |
| Holiday | `HL` |
| Paid Leave | `PL` |
| Leave Without Pay | `LWP` |
| Absent | `A` |
| *(no column)* | `--` — tracked internally as `noShift` |
| Total Hours | `Σ workMinutes` |

```
fmtMinutes(m) = floor(max(0, round(m)) / 60) : pad2(m % 60)
```

Hours count **past 24** — `155:33` is a hundred and fifty-five hours, not a
time of day.

---

## 7. Layout

### CSV — eight rows per person

```
Dept. Name , team , '' , CompName , workspace , '' , Report Month , August-2026
Email , email , '' , Name , name , '' , Present , n , Half Day , n , … , Total Hours , HH:MM
'' , 1 , 2 , 3 … 31
'' , Sat , Sun , Mon … 
Office In           , HH:MM or --:-- …
Office Out          , HH:MM or --:-- …
Total Working Hours , HH:MM …
Status              , P | HD | A | WO | HL | PL | LWP | -- …
```

Blocks are separated by a blank line. A cell containing `"`, `,`, CR or LF is
wrapped in quotes with internal quotes doubled (RFC 4180).

### Workbook

Three sheets. The grid shares its six data rows with the CSV — the same
function builds both, so neither can grow a column the other lacks.

The per-person strip **hides any count that is zero**, except Present, Absent
and Total Hours, where a zero is itself the finding. The CSV always carries all
eight columns, because a data file's columns must not move.

Status cells are filled with the `DESIGN.md` block palette by category, not by
judgement — `A` is a different block from `P`, not a warning.

---

## 8. Reading a disagreement

| What you see | What it means |
|---|---|
| `--:--` all month, hours present | The punch import is missing this person. Check their code on the machine. |
| Badge times, `00:00` hours, `A` | The agent is not running, or stopped mid-day. |
| Hours far below the badge span | Idle trimming, or the lease expired and the entry closed at the last proven moment (§3.1). |
| `--` for a whole month | No shift assignment, or its schedule snapshot will not parse. |
| `A` on a day they took leave | The leave is not approved in Lark, or has not synced. |
| Holiday shows `WO` | It fell on their weekly off. Step 2 beats step 3 (§5.1). |
| Leave day shows `HL` | A holiday fell inside the leave. It costs no balance, by design. |
| Manual time seems missing from the hours | Live tracking already claimed that instant. Tracked beats manual (§3.2). |

---

## 9. Where the rules live

| File | Owns |
|---|---|
| `reports/monthPerformance.ts` | Status precedence, totals, formatting, CSV |
| `reports/monthPerformanceData.ts` | The three loads and the lookback window |
| `reports/monthPerformanceXlsx.ts` | The workbook |
| `attendance/punches.ts` | Why a missing punch is a dash |
| `insights/timesheets.ts` | Bucketing, idle removal, day clipping |
| `insights/overlap.ts` | `CLAIM_PRIORITY` and overlap resolution |
| `insights/invalidations.ts` | Subtracting struck-out time |
| `insights/openSegmentEvidence.ts` | Where an open segment ends |
| `leave/workingCalendar.ts` | Shift, holiday and leave precedence |

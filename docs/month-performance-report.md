# Month Performance Report — how every number is made

The monthly attendance grid, downloadable as CSV and `.xlsx` from
**Reports → Team** and **Attendance**.

This document says exactly where each figure comes from, so that when the
report disagrees with somebody's memory there is a way to find out which one is
wrong. It is written against the code, not from memory — if you change
`apps/api/src/reports/monthPerformance.ts`, change this too.

---

## What comes out

One block per person, eight rows, one column per day of the month.

```
Dept. Name  Technical            CompName  EMIAC …      Report Month  August-2026
Email       sujeet@…    Name  Sujeet Kar   Present 21  Half Day 0  …  Total Hours 155:33
             1      2      3      4    …        (day of month)
            Sat    Sun    Mon    Tue   …        (weekday)
Office In           09:34  --:--  09:48  09:55  …
Office Out          18:23  --:--  18:45  18:12  …
Total Working Hours 08:04  00:00  08:12  07:32  …
Status              P      WO     P      P      …
```

The grid always spans the **whole month**, taken from the month itself and not
from whichever days happen to have data — an empty report still shows 31
columns.

### Endpoints

| | |
|---|---|
| `GET /v1/reports/month-performance.csv` | CSV, one block per person |
| `GET /v1/reports/month-performance.xlsx` | Workbook: grid, Summary, Legend |
| Query | `?month=YYYY-MM` (defaults to the current month in the workspace timezone) |
| Permission | `reports.team.read` |
| Who you see | `req.scope.userIds` — a manager gets their team, an admin the workspace |

---

## The three sources

Nothing in this report is invented. Every cell traces to one of three places.

| Source | Supplies |
|---|---|
| **`AttendancePunch`** — the biometric record | Office In, Office Out |
| **Timo tracked time** — time entries and their segments | Total Working Hours, and whether a day counts as worked |
| **Working Calendar** — fed by the Lark leave integration | Holiday, weekly off, paid and unpaid leave, half days |

Punch and tracked time sit side by side deliberately. Where they disagree —
badged in at 09:55 but only two hours recorded — the row prints both. Neither
silently overrides the other.

---

## Office In / Office Out

Straight from `AttendancePunch`, the record the biometric machine writes.

- Shown **exactly as recorded**. Never inferred from tracked activity.
- `--:--` means **no punch was recorded**. That is a fact, and printing `00:00`
  instead would be a different and false one.
- A punch-in with no punch-out is normal and is shown that way.

The punch stores a clock reading, not an instant — there is no timezone applied
on read, because "09:34" is what the machine saw on the wall.

---

## Total Working Hours

Timo's tracked time for that person on that day, formatted `HH:MM`.

**What counts**

- Work segments
- Meeting segments
- Approved manual time (time somebody requested and a manager approved)

**What does not count**

- **Idle-trimmed time.** When the agent detects idleness it trims that span;
  trimming it and then counting it would defeat the trim.
- **Invalidated time.** Spans an admin has struck out are subtracted.
- **Overlaps.** If two entries claim the same instant for one person, the
  instant is awarded once. Manual beats tracked, tracked beats idle. Two
  different people working the same hour is not an overlap.

**Day boundaries** are the workspace timezone's local day, not UTC. A segment
crossing local midnight is split between the two days it touches.

This is *not* the gap between the two punches. Badge 09:00–18:00 with three
hours recorded shows `03:00`, and the Office In / Office Out row above shows
why the two differ.

---

## Status — the one that gets asked about

Two rules, in order. There is no third rule and no threshold.

### 1. The calendar wins outright

| Code | Means |
|---|---|
| `HL` | Company holiday |
| `WO` | Weekly off — the assigned shift has this weekday off |
| `PL` | Approved **paid** leave, full day |
| `LWP` | Approved **unpaid** leave, full day |
| `HD` | Approved leave covering **half** the day |

A holiday stays `HL` even if the person worked it, and leave stays leave. Their
hours still show on the row above. If the code changed whenever somebody worked
a holiday, the holiday and leave counts would stop adding up.

`HD` comes **only** from half-day leave. It is never inferred from hours.

### 2. Otherwise, the hours

| Code | Means |
|---|---|
| `P` | **Any** tracked time at all |
| `A` | A working day with none |
| `--` | No shift assignment covers the date, and nothing tracked |

**There is no minimum.** One tracked minute reads `P`.

This is deliberate. A floor at four or eight hours only decides which side of an
arbitrary line a real working day falls on, and the hours are already printed
directly above — a reader can see six hours and judge six hours for themselves.
The status answers *did they work*; the hours answer *how much*.

An earlier version used an eight-hour floor. In this workspace that sat exactly
on the median tracked day, so it split the workforce roughly in half on
ten-minute differences and produced 743 half days in one month.

### `--` is not absence

If nobody has assigned a shift, Timo cannot say the person was expected to be
there — so it does not call them absent. `--` means *we have no opinion*, and
it is a sign somebody needs a shift assignment.

---

## What is deliberately NOT used

**The payroll classifier.** Payroll applies two fairness rules that are right
for deciding pay and wrong for an attendance record:

- a **monthly guarantee** that upgrades every eligible day once the month total
  clears a floor, and
- a **carry allocator** that moves surplus tracked time from one day onto a
  thinner one.

Under those rules a day with two tracked hours can read as a full day. This
report judges every day on that day's own tracked time and nothing else. The
payroll worksheet remains the place to see the paid view.

---

## The per-person summary

The strip beside each name. Every day of the month falls into exactly one
bucket, so the seven counts always sum to the length of the month.

| Field | Counts |
|---|---|
| Present | days coded `P` |
| Half Day | days coded `HD` |
| Weekly Off | days coded `WO` |
| Holiday | days coded `HL` |
| Paid Leave | days coded `PL` |
| Leave Without Pay | days coded `LWP` |
| Absent | days coded `A` |
| Total Hours | sum of the Total Working Hours row |

Total Hours counts past 24 — `155:33` is a hundred and fifty-five hours, not a
time of day.

In the workbook the strip hides any count that is zero, except Present, Absent
and Total Hours, which always appear because a zero in those is itself the
finding. The CSV always carries all eight columns, because a data file's
columns must not move.

---

## Reading a disagreement

| What you see | What it usually means |
|---|---|
| `--:--` all month, hours present | The punch import is missing this person. Check their employee code on the machine. |
| Badge times present, `00:00` hours, `A` | The agent is not running on their machine, or stopped mid-day. |
| Hours much lower than the badge span | Idle trimming, or the agent lost its connection and the server closed the entry at the last proven moment. |
| `--` for the whole month | No shift assignment. |
| `A` on a day they say they took leave | The leave is not approved in Lark, or has not synced yet. |

---

## Related

- `apps/api/src/reports/monthPerformance.ts` — the rules, and the only place
  they live
- `apps/api/src/reports/monthPerformanceData.ts` — the three loads
- `apps/api/src/reports/monthPerformanceXlsx.ts` — the workbook, styled to
  `DESIGN.md`
- `apps/api/src/attendance/punches.ts` — why a missing punch is a dash
- `apps/api/src/insights/timesheets.ts` — what counts as tracked time
- `apps/api/src/leave/workingCalendar.ts` — holiday / weekly off / leave
  precedence

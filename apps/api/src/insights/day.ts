/**
 * Pure helpers for the per-day timeline ("Edit Time" tab).
 *
 * Strategy:
 *   1. Compute the local-day window in the user's IANA timezone (DST-correct).
 *   2. Clip every TimeSegment that overlaps the window.
 *   3. Tag each clipped segment with a kind that the UI renders directly:
 *        - WORK / MEETING / IDLE_TRIMMED come straight from the segment kind
 *        - MANUAL overrides them when the parent TimeEntry.source === 'MANUAL'
 *   4. Compute GAP blocks between adjacent non-gap blocks, but only inside
 *      [firstActivityAt .. lastActivityAt] (or .. now for today). Outside that
 *      envelope we don't fabricate a "you were idle since midnight" — the user
 *      just hadn't started yet.
 *   5. Surface PENDING ManualTimeRequests overlapping the window as a separate
 *      array so the UI can render a striped overlay without confusing them
 *      with real, already-approved blocks.
 *
 * No prisma/network calls in this file. The route owns I/O; this owns logic.
 */

export type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
export type BlockKind = SegmentKind | 'MANUAL' | 'GAP';

export interface DayEntryInput {
  id: string;
  source: 'AUTO' | 'MANUAL';
  larkTaskGuid: string | null;
  segments: Array<{
    kind: SegmentKind;
    startedAt: Date;
    endedAt: Date | null; // null => still running
  }>;
}

export interface PendingRequestInput {
  id: string;
  requestedStart: Date;
  requestedEnd: Date;
  reason: string;
  larkTaskGuid: string | null;
}

export interface DayBlock {
  kind: BlockKind;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms (exclusive)
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  reason?: string | null;
  isOpen?: boolean;
}

export interface DayInsightResult {
  date: string;
  timezone: string;
  dayStart: number;
  dayEnd: number;
  isFuture: boolean;
  isToday: boolean;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; gapMs: number };
  blocks: DayBlock[];
  pendingOverlay: Array<{ id: string; startedAt: number; endedAt: number; reason: string; larkTaskGuid: string | null }>;
}

/**
 * Compute the local-day window for `date` (YYYY-MM-DD) in IANA `tz`. Returns
 * `null` if either input is invalid. DST-correct: a 23h spring-forward day
 * returns end-start = 23h.
 */
export function localDayWindow(date: string, tz: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return null;
  }
  const [y, m, d] = date.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const start = utcInstantForLocalMidnight(y, m, d, tz);
  // For the next day's midnight, increment day then resolve again — this
  // naturally yields a 23h / 25h span on DST transition days.
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const ny = tomorrow.getUTCFullYear();
  const nm = tomorrow.getUTCMonth() + 1;
  const nd = tomorrow.getUTCDate();
  const end = utcInstantForLocalMidnight(ny, nm, nd, tz);
  return { start, end };
}

/**
 * Solve for the UTC instant whose wall-clock in `tz` is
 * `year-month-day 00:00:00`. Algorithm: format a guess, treat the formatted
 * components as if they were a UTC instant, compare to the target, shift by
 * the delta. Converges in <=2 iterations because the tz offset is constant
 * away from DST transitions, and a 1h adjustment crosses the transition.
 */
function utcInstantForLocalMidnight(year: number, month: number, day: number, tz: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  // First guess: pretend tz offset is 0.
  let guess = target;
  for (let iter = 0; iter < 4; iter++) {
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(guess))) if (p.type !== 'literal') map[p.type] = p.value;
    const hourStr = map.hour === '24' ? '00' : map.hour!;
    const seen = Date.UTC(
      parseInt(map.year!, 10),
      parseInt(map.month!, 10) - 1,
      parseInt(map.day!, 10),
      parseInt(hourStr, 10),
      parseInt(map.minute!, 10),
      parseInt(map.second!, 10),
    );
    const delta = seen - target;
    if (delta === 0) return new Date(guess);
    guess -= delta;
  }
  return new Date(guess);
}

/** Clip [a,b) by [lo,hi) → returns null when disjoint. */
function clip(a: number, b: number, lo: number, hi: number): { a: number; b: number } | null {
  const start = Math.max(a, lo);
  const end = Math.min(b, hi);
  return end > start ? { a: start, b: end } : null;
}

/**
 * Main composer. `now` lets tests be deterministic.
 */
export function buildDayInsight(input: {
  date: string;
  tz: string;
  now: Date;
  entries: DayEntryInput[];
  pending: PendingRequestInput[];
  window: { start: Date; end: Date };
}): DayInsightResult {
  const { date, tz, now, entries, pending, window: win } = input;
  const dayStart = win.start.getTime();
  const dayEnd = win.end.getTime();
  const nowMs = now.getTime();
  const isToday = dayStart <= nowMs && nowMs < dayEnd;
  const isFuture = nowMs < dayStart;

  // 1. Flatten + clip segments → tagged blocks.
  const tagged: DayBlock[] = [];
  for (const e of entries) {
    for (const s of e.segments) {
      const segStart = s.startedAt.getTime();
      const segEndRaw = s.endedAt ? s.endedAt.getTime() : Math.min(nowMs, dayEnd);
      const c = clip(segStart, segEndRaw, dayStart, dayEnd);
      if (!c) continue;
      const kind: BlockKind = e.source === 'MANUAL' ? 'MANUAL' : s.kind;
      tagged.push({
        kind,
        startedAt: c.a,
        endedAt: c.b,
        durationMs: c.b - c.a,
        timeEntryId: e.id,
        larkTaskGuid: e.larkTaskGuid,
        isOpen: s.endedAt === null && isToday,
      });
    }
  }
  // Sort + merge nothing — segments don't overlap (timer invariant). Sort only.
  tagged.sort((a, b) => a.startedAt - b.startedAt);

  // 2. Activity envelope.
  const firstActivityAt = tagged.length ? tagged[0]!.startedAt : null;
  // For today, the envelope's right edge is `now` (a gap right before now
  // counts as a gap); for past days it's the latest tracked endedAt.
  let lastActivityAt: number | null = null;
  if (tagged.length) {
    const lastSegEnd = tagged[tagged.length - 1]!.endedAt;
    lastActivityAt = isToday ? Math.max(lastSegEnd, nowMs) : lastSegEnd;
  }

  // 3. Insert GAP blocks between adjacent tagged blocks, inside the envelope.
  const blocks: DayBlock[] = [];
  if (tagged.length === 0) {
    // Empty day → no blocks. UI shows empty state.
  } else {
    for (let i = 0; i < tagged.length; i++) {
      const cur = tagged[i]!;
      // Gap from previous block's end (or envelope start) to this block's start.
      const prevEnd = i === 0 ? firstActivityAt! : tagged[i - 1]!.endedAt;
      if (i > 0 && cur.startedAt > prevEnd) {
        blocks.push({
          kind: 'GAP',
          startedAt: prevEnd,
          endedAt: cur.startedAt,
          durationMs: cur.startedAt - prevEnd,
        });
      }
      blocks.push(cur);
    }
    // Trailing gap (today only): from last tracked end to now.
    if (isToday) {
      const last = tagged[tagged.length - 1]!;
      if (nowMs > last.endedAt) {
        blocks.push({
          kind: 'GAP',
          startedAt: last.endedAt,
          endedAt: nowMs,
          durationMs: nowMs - last.endedAt,
        });
      }
    }
  }

  // 4. Pending overlay — clip each request's range to the day.
  const pendingOverlay = pending
    .map((p) => {
      const c = clip(p.requestedStart.getTime(), p.requestedEnd.getTime(), dayStart, dayEnd);
      if (!c) return null;
      return { id: p.id, startedAt: c.a, endedAt: c.b, reason: p.reason, larkTaskGuid: p.larkTaskGuid };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.startedAt - b.startedAt);

  // 5. Totals.
  const totals = { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, gapMs: 0 };
  for (const b of blocks) {
    if (b.kind === 'WORK') totals.workedMs += b.durationMs;
    else if (b.kind === 'MEETING') totals.meetingMs += b.durationMs;
    else if (b.kind === 'MANUAL') totals.manualMs += b.durationMs;
    else if (b.kind === 'IDLE_TRIMMED') totals.idleTrimmedMs += b.durationMs;
    else if (b.kind === 'GAP') totals.gapMs += b.durationMs;
  }

  return {
    date,
    timezone: tz,
    dayStart,
    dayEnd,
    isFuture,
    isToday,
    firstActivityAt,
    lastActivityAt,
    totals,
    blocks,
    pendingOverlay,
  };
}

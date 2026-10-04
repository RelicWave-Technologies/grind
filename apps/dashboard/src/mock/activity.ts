/**
 * Deterministic tracked-time generator.
 *
 * Every person-day is produced from a seeded RNG keyed on (person, date), so
 * it is identical across reloads, polls and roles. Edits (notes, task, delete)
 * are overlaid from the store's `entryPatches`; manual time lives in the store
 * as real rows because it is created by approvals during the session.
 */
import { portionDays } from '@grind/types';
import { addDays, atMinute, compareKeys, dayWindow, hhmmToMinute, HOUR, MIN, minuteOfDay, prevWeekday, todayKey, weekdayOf } from './clock';
import { dbRevision, type DbHoliday, type DbLeaveRequest, type DbShift, type DbUser, type MockDb } from './db';
import { APP_MIX, MEETINGS, ROLE_PERSONA, TASKS, TEAMS, WORK_NOTES, type Persona, type TeamKey } from './people';
import { rngFor, type Rng } from './rng';

export type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';

export interface GenSegment {
  kind: SegmentKind;
  start: number;
  end: number;
  open: boolean;
}

export interface GenEntry {
  id: string;
  userId: string;
  source: 'TRACKED' | 'MANUAL';
  larkTaskGuid: string | null;
  notes: string | null;
  attendeeIds: string[];
  segments: GenSegment[];
  requestId: string | null;
  /** APPS key of the app that dominated this entry. */
  app: string;
}

export interface DayPlan {
  kind: 'none' | 'off' | 'holiday' | 'leave' | 'absent' | 'work';
  start: number;
  end: number;
  /** Punch record, minutes since local midnight. */
  punchIn: number | null;
  punchOut: number | null;
  /** Tracked time exists but the agent never sent activity samples. */
  noSamples: boolean;
}

interface PersonaTraits {
  start: [number, number];
  end: [number, number];
  absent: number;
  act: [number, number];
}

export const PERSONA: Record<Persona, PersonaTraits> = {
  steady: { start: [-8, 12], end: [-10, 35], absent: 0.02, act: [62, 90] },
  early: { start: [-35, -5], end: [-25, 10], absent: 0.02, act: [58, 86] },
  late: { start: [18, 75], end: [5, 55], absent: 0.05, act: [45, 78] },
  erratic: { start: [-15, 95], end: [-50, 70], absent: 0.07, act: [30, 88] },
  night: { start: [-10, 25], end: [-25, 10], absent: 0.03, act: [55, 85] },
  meetings: { start: [-12, 8], end: [0, 45], absent: 0.02, act: [40, 72] },
  sales: { start: [-5, 35], end: [-35, 15], absent: 0.04, act: [38, 70] },
};

const ME_IDS = new Set(Object.values(ROLE_PERSONA));

export function teamKeyOf(teamId: string | null): TeamKey | null {
  return TEAMS.find((t) => t.id === teamId)?.key ?? null;
}

export function shiftOf(db: MockDb, user: DbUser): DbShift | null {
  return user.shiftId ? db.shifts.find((s) => s.id === user.shiftId) ?? null : null;
}

export function scheduleOn(db: MockDb, user: DbUser, date: string): { start: string; end: string } | null {
  const shift = shiftOf(db, user);
  return shift ? shift.schedule[weekdayOf(date)] : null;
}

export function shiftWindowOn(db: MockDb, user: DbUser, date: string): { start: number; end: number } | null {
  const slot = scheduleOn(db, user, date);
  if (!slot) return null;
  return { start: atMinute(date, hhmmToMinute(slot.start)), end: atMinute(date, hhmmToMinute(slot.end)) };
}

export function holidayOn(db: MockDb, user: DbUser, date: string): DbHoliday | null {
  return db.holidays.find((h) => h.date === date && (h.teamId === null || h.teamId === user.teamId)) ?? null;
}

export function approvedLeaveOn(db: MockDb, userId: string, date: string): DbLeaveRequest | null {
  return (
    db.leaveRequests.find(
      (r) => r.userId === userId && r.status === 'APPROVED' && r.startDate <= date && r.endDate >= date,
    ) ?? null
  );
}

/** Days with scripted trouble, relative to the seed day. */
function scripted(db: MockDb): { noSamples: Set<string>; absent: Set<string> } {
  const today = db.seedDay;
  return {
    noSamples: new Set([
      `usr_ananya|${prevWeekday(addDays(today, -4))}`,
      `usr_aditya|${prevWeekday(addDays(today, -2))}`,
      `usr_kabir|${prevWeekday(addDays(today, -6))}`,
    ]),
    absent: new Set([
      `usr_vikram|${prevWeekday(addDays(today, -3))}`,
      `usr_rhea|${prevWeekday(addDays(today, -8))}`,
    ]),
  };
}

export function planDay(db: MockDb, user: DbUser, date: string): DayPlan {
  const none: DayPlan = { kind: 'none', start: 0, end: 0, punchIn: null, punchOut: null, noSamples: false };
  if (user.provisioningStatus === 'PENDING') return none;
  const cal = dayWindow(date);
  if (cal.end <= user.createdAt) return none;
  if (user.deactivatedAt !== null && cal.start >= user.deactivatedAt) return none;
  if (compareKeys(date, todayKey()) > 0) return none;

  const rng = rngFor('plan', user.id, date);
  const script = scripted(db);
  const key = `${user.id}|${date}`;
  if (holidayOn(db, user, date)) return { ...none, kind: 'holiday' };

  const leave = approvedLeaveOn(db, user.id, date);
  if (leave && leave.portion === 'FULL') return { ...none, kind: 'leave' };

  let slot = scheduleOn(db, user, date);
  const relative = relativeToday(db, user, date, slot);
  if (relative) return relative;
  if (!slot) {
    // Weekly off. The erratic engineer sometimes squeezes in a little work.
    if (user.persona === 'erratic' && weekdayOf(date) === 'sat' && rng.chance(0.45)) {
      slot = { start: '11:30', end: '13:15' };
    } else {
      return { ...none, kind: 'off' };
    }
  }

  const traits = PERSONA[user.persona];
  const isMe = ME_IDS.has(user.id);
  const recent = compareKeys(date, addDays(db.seedDay, -10)) > 0;
  if (script.absent.has(key) || (!(isMe && recent) && rng.chance(traits.absent))) {
    return { ...none, kind: 'absent' };
  }

  let startOff = rng.int(traits.start[0], traits.start[1]);
  if (user.persona === 'late' && rng.chance(0.3)) startOff = rng.int(0, 10);
  const endOff = rng.int(traits.end[0], traits.end[1]);
  const shiftStartMin = hhmmToMinute(slot.start);
  const shiftEndMin = hhmmToMinute(slot.end);
  let startMin = shiftStartMin + startOff;
  let endMin = Math.min(shiftEndMin + endOff, 23 * 60 + 58);
  if (leave) {
    const mid = Math.round((shiftStartMin + shiftEndMin) / 2);
    if (leave.portion === 'FIRST_HALF') startMin = mid + rng.int(10, 30);
    else endMin = mid - rng.int(5, 20);
  }
  const start = atMinute(date, startMin);
  const end = atMinute(date, endMin);
  const hasPunch = rng.chance(0.78);
  const isToday = date === todayKey();
  return {
    kind: 'work',
    start,
    end,
    punchIn: hasPunch ? Math.max(0, startMin - rng.int(2, 14)) : null,
    punchOut: hasPunch && !isToday ? Math.min(1439, endMin + rng.int(3, 12)) : null,
    noSamples: script.noSamples.has(key),
  };
}

/**
 * "Today" for the signed-in personas (and two others at weekends) is laid out
 * around the moment the store was seeded, so Home, Edit Time and Overview have
 * a live day — including a running timer — whatever the hour or weekday the
 * designer opens the mock. Anchored to `seededAt`, not `now`, so it does not
 * drift while the page polls.
 */
const RELATIVE_TODAY: Record<string, { start: number; end: number; always: boolean }> = {
  usr_meera: { start: -290, end: 150, always: true },
  usr_arjun: { start: -230, end: 120, always: true },
  usr_ananya: { start: -320, end: 75, always: true },
  usr_daniel: { start: -200, end: 90, always: false },
  usr_vikram: { start: -150, end: -40, always: false },
};

function relativeToday(db: MockDb, user: DbUser, date: string, slot: { start: string; end: string } | null): DayPlan | null {
  const rel = RELATIVE_TODAY[user.id];
  if (!rel || date !== db.seedDay) return null;
  const seededMin = minuteOfDay(db.seededAt);
  if (slot) {
    // A normal workday that is already well under way keeps its real shape.
    if (!rel.always || seededMin >= hhmmToMinute(slot.start) + 60) return null;
  }
  const startMin = Math.max(15, Math.round((seededMin + rel.start) / 5) * 5);
  const endMin = Math.min(23 * 60 + 58, seededMin + rel.end);
  if (endMin - startMin < 45 || seededMin - startMin < 30) return null;
  return {
    kind: 'work',
    start: atMinute(date, startMin),
    end: atMinute(date, endMin),
    punchIn: slot ? Math.max(0, startMin - 6) : null,
    punchOut: null,
    noSamples: false,
  };
}

interface PlannedMeeting {
  start: number;
  dur: number;
  title: string;
  done: boolean;
}

function teammates(db: MockDb, user: DbUser): DbUser[] {
  return db.users.filter(
    (u) => u.id !== user.id && u.deactivatedAt === null && u.provisioningStatus === 'ACTIVE' && (user.teamId ? u.teamId === user.teamId : u.role !== 'MEMBER'),
  );
}

function pickAttendees(db: MockDb, user: DbUser, rng: Rng): string[] {
  const pool = teammates(db, user);
  const count = Math.min(pool.length, rng.int(1, 3));
  const out = new Set<string>();
  for (let i = 0; i < count * 3 && out.size < count; i++) out.add(rng.pick(pool).id);
  return [...out];
}

function planMeetings(user: DbUser, date: string, plan: DayPlan, rng: Rng): PlannedMeeting[] {
  const out: PlannedMeeting[] = [];
  const titles = MEETINGS[user.discipline];
  const earliest = plan.start + 30 * MIN;
  const latest = plan.end - 45 * MIN;
  if (latest <= earliest) return out;
  const add = (start: number, durMin: number, title: string) => {
    const snapped = Math.round(start / (5 * MIN)) * 5 * MIN;
    if (snapped < earliest || snapped > latest) return;
    if (out.some((m) => snapped < m.start + m.dur + 10 * MIN && m.start < snapped + durMin * MIN + 10 * MIN)) return;
    out.push({ start: snapped, dur: durMin * MIN, title, done: false });
  };
  const span = latest - earliest;
  if (user.discipline === 'eng') add(atMinute(date, 11 * 60), 15, 'Daily standup');
  if (user.discipline === 'design' && rng.chance(0.45)) add(earliest + span * rng.range(0.55, 0.8), 45, rng.pick(titles));
  if (user.discipline === 'growth') {
    const calls = rng.int(1, 2);
    for (let i = 0; i < calls; i++) add(earliest + span * rng.next(), rng.pick([30, 45]), rng.pick(titles));
  }
  if (user.discipline === 'ops') add(earliest + span * rng.range(0.1, 0.9), rng.pick([30, 60]), rng.pick(titles));
  if (user.persona === 'meetings') {
    const extra = rng.int(2, 3);
    for (let i = 0; i < extra; i++) add(earliest + span * rng.next(), rng.pick([30, 45, 60]), rng.pick([...titles, '1:1s', 'Client review']));
  }
  return out.sort((a, b) => a.start - b.start);
}

function pickTask(user: DbUser, rng: Rng): string | null {
  const team = teamKeyOf(user.teamId);
  const roll = rng.next();
  if (roll < 0.7 && team) {
    const own = TASKS.filter((t) => t.team === team);
    if (own.length) return rng.pick(own).guid;
  }
  if (roll < 0.86) return rng.pick(TASKS.filter((t) => t.team === null)).guid;
  return null;
}

function buildDay(db: MockDb, user: DbUser, date: string, plan: DayPlan): GenEntry[] {
  const rng = rngFor('day', user.id, date);
  const out: GenEntry[] = [];
  const meetings = planMeetings(user, date, plan, rng);
  const isNight = user.persona === 'night';
  const lunchAt = isNight ? atMinute(date, 20 * 60 + rng.int(0, 25)) : plan.start + rng.int(200, 250) * MIN;
  const lunchDur = rng.int(30, 45) * MIN;
  let lunchDone = plan.end - plan.start < 5 * HOUR;
  let t = plan.start;
  let n = 0;
  const idFor = () => `te_${user.id.slice(4)}_${date.replace(/-/g, '')}_${n++}`;

  for (let guard = 0; t < plan.end - 5 * MIN && guard < 80; guard++) {
    if (!lunchDone && t >= lunchAt) {
      t += lunchDur;
      lunchDone = true;
      continue;
    }
    const meeting = meetings.find((m) => !m.done && m.start <= t + 2 * MIN);
    if (meeting) {
      meeting.done = true;
      const mEnd = Math.min(t + meeting.dur, plan.end);
      out.push({
        id: idFor(),
        userId: user.id,
        source: 'TRACKED',
        larkTaskGuid: rng.chance(0.4) ? pickTask(user, rng) : null,
        notes: meeting.title,
        attendeeIds: pickAttendees(db, user, rng),
        segments: [{ kind: 'MEETING', start: t, end: mEnd, open: false }],
        requestId: null,
        app: user.discipline === 'growth' || user.discipline === 'ops' ? 'zoom' : 'lark',
      });
      t = mEnd;
      continue;
    }
    const nextMeeting = meetings.find((m) => !m.done)?.start ?? Number.POSITIVE_INFINITY;
    const lunchBoundary = lunchDone ? Number.POSITIVE_INFINITY : lunchAt;
    const blockEnd = Math.min(t + rng.int(35, 105) * MIN, plan.end, nextMeeting, lunchBoundary);
    if (blockEnd - t < 6 * MIN) {
      t = Math.max(blockEnd, t + MIN);
      continue;
    }
    const segments: GenSegment[] = [];
    if (blockEnd - t > 45 * MIN && rng.chance(0.24)) {
      const mid = t + Math.round(((blockEnd - t) * rng.range(0.35, 0.65)) / MIN) * MIN;
      const idleEnd = Math.min(mid + rng.int(5, 12) * MIN, blockEnd - 5 * MIN);
      segments.push({ kind: 'WORK', start: t, end: mid, open: false });
      segments.push({ kind: 'IDLE_TRIMMED', start: mid, end: idleEnd, open: false });
      segments.push({ kind: 'WORK', start: idleEnd, end: blockEnd, open: false });
    } else {
      segments.push({ kind: 'WORK', start: t, end: blockEnd, open: false });
    }
    out.push({
      id: idFor(),
      userId: user.id,
      source: 'TRACKED',
      larkTaskGuid: pickTask(user, rng),
      notes: rng.chance(0.35) ? rng.pick(WORK_NOTES[user.discipline]) : null,
      attendeeIds: [],
      segments,
      requestId: null,
      app: rng.weighted(APP_MIX[user.discipline]),
    });
    t = blockEnd;
    if (rng.chance(0.24)) {
      const brk = rng.int(5, 18) * MIN;
      if (t + brk < nextMeeting) t += brk;
    }
  }
  return out;
}

/** Trim a generated day at `now`; the segment spanning now is the running timer. */
function cutAt(entries: GenEntry[], now: number, plan: DayPlan): GenEntry[] {
  const out: GenEntry[] = [];
  const stillWorking = now < plan.end;
  for (const e of entries) {
    const segments: GenSegment[] = [];
    for (const s of e.segments) {
      if (s.start >= now) continue;
      if (s.end > now) segments.push({ ...s, end: now, open: stillWorking && s.kind !== 'IDLE_TRIMMED' });
      else segments.push(s);
    }
    if (segments.length) out.push({ ...e, segments });
  }
  return out;
}

let memoRev = -1;
const memo = new Map<string, GenEntry[]>();

function rawGenerated(db: MockDb, user: DbUser, date: string, now: number): GenEntry[] {
  const today = todayKey();
  if (date !== today) {
    if (memoRev !== dbRevision()) {
      memo.clear();
      memoRev = dbRevision();
    }
    const key = `${user.id}|${date}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const plan = planDay(db, user, date);
    const result = plan.kind === 'work' ? buildDay(db, user, date, plan) : [];
    memo.set(key, result);
    return result;
  }
  const plan = planDay(db, user, date);
  if (plan.kind !== 'work' || now < plan.start) return [];
  return cutAt(buildDay(db, user, date, plan), now, plan);
}

function applyPatch(db: MockDb, entry: GenEntry): GenEntry | null {
  const patch = db.entryPatches[entry.id];
  if (!patch) return entry;
  if (patch.deleted) return null;
  return {
    ...entry,
    ...(patch.larkTaskGuid !== undefined ? { larkTaskGuid: patch.larkTaskGuid } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.attendeeIds !== undefined ? { attendeeIds: patch.attendeeIds } : {}),
  };
}

/** Tracked + manual entries touching the calendar day, with edits applied. */
export function entriesForDay(db: MockDb, user: DbUser, date: string, now: number): GenEntry[] {
  const cal = dayWindow(date);
  const tracked = rawGenerated(db, user, date, now);
  const manual: GenEntry[] = db.manualEntries
    .filter((m) => m.userId === user.id && m.start < cal.end && m.end > cal.start)
    .map((m) => ({
      id: m.id,
      userId: m.userId,
      source: 'MANUAL' as const,
      larkTaskGuid: m.larkTaskGuid,
      notes: m.notes,
      attendeeIds: m.attendeeIds,
      segments: [{ kind: 'WORK' as const, start: m.start, end: m.end, open: false }],
      requestId: m.requestId,
      app: rngFor('manual-app', m.id).weighted(APP_MIX[user.discipline]),
    }));
  const out: GenEntry[] = [];
  for (const e of [...tracked, ...manual]) {
    const patched = applyPatch(db, e);
    if (patched) out.push(patched);
  }
  return out;
}

/** Stretches inside the shift with no tracked time, up to `now` — seeding uses these. */
export function freeSlots(db: MockDb, user: DbUser, date: string, now: number): Array<{ start: number; end: number }> {
  const plan = planDay(db, user, date);
  // Nobody files manual time for a holiday, a leave day or a weekly off.
  if (plan.kind !== 'work' && plan.kind !== 'absent') return [];
  const win = shiftWindowOn(db, user, date) ?? (plan.kind === 'work' ? { start: plan.start, end: plan.end } : null);
  if (!win) return [];
  const cap = Math.min(win.end, now);
  const busy = entriesForDay(db, user, date, now)
    .flatMap((e) => e.segments.map((s) => ({ start: s.start, end: s.end })))
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = win.start;
  for (const b of busy) {
    if (b.start > cursor && b.start <= cap) out.push({ start: cursor, end: Math.min(b.start, cap) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < cap) out.push({ start: cursor, end: cap });
  return out.filter((s) => s.end - s.start >= 15 * MIN);
}

export function isTrackingNow(db: MockDb, user: DbUser, now: number): boolean {
  return entriesForDay(db, user, todayKey(), now).some((e) => e.segments.some((s) => s.open));
}

/** Working days a leave request charges (weekly offs and holidays are free). */
export function chargedDaysFor(db: MockDb, user: DbUser, startDate: string, endDate: string, portion: 'FULL' | 'FIRST_HALF' | 'SECOND_HALF', paid: boolean): number {
  if (!paid) return 0;
  if (portion !== 'FULL') return portionDays(portion);
  let days = 0;
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (!scheduleOn(db, user, d)) continue;
    if (holidayOn(db, user, d)) continue;
    days += 1;
  }
  return days;
}

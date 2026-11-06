import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@grind/db';
import { TICKET_CATEGORIES, addDays, dateKeyInTimeZone, todayKey, type Role, type TicketCategory } from '@grind/types';
import { classifySyncHealth, SYNC_HEALTH_SELECT } from '../agent/syncHealth';
import { selfGet, SelfApiError } from './selfApi';

/**
 * What the support agent can look at and do.
 *
 * Every read is about the person in the chat and nobody else: no tool takes a
 * user id, the id comes from the Lark sender. Reads go through the dashboard's
 * own endpoints (see selfApi) or plain queries on the asker's rows, and come
 * back trimmed to what a support person would read: local times, "7h 32m",
 * no ids. The one action, offer_ticket, only puts a ticket card in front of the
 * person; nothing is filed until they press Open ticket.
 */

export interface SupportPerson {
  userId: string;
  workspaceId: string;
  role: Role;
  name: string;
  timezone: string;
  openId: string;
}

/** What offer_ticket asked for; the agent loop sends the card after its reply. */
export interface TicketOffer {
  subject: string;
  category: TicketCategory;
  details: string;
  relatedTicketNumber: number | null;
}

export interface ToolRunState {
  offer: TicketOffer | null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const totalMin = Math.round(Math.max(0, ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function fmtClock(epochMs: number | null | undefined, timeZone: string): string | null {
  if (epochMs == null || !Number.isFinite(epochMs)) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epochMs);
}

/** "Tue 4 Nov 2026" for a YYYY-MM-DD key. */
export function fmtDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date).replace(',', '');
}

function minuteClock(minute: number | null | undefined): string | null {
  if (minute == null || !Number.isFinite(minute)) return null;
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;

function isDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_KEY.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** Whole days from a to b (both YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const ATTENDANCE_CODE_MEANING: Record<string, string> = {
  P: 'present',
  PL: 'full day paid leave',
  LWP: 'full day leave without pay',
  PL_HD: 'half day paid leave',
  LWP_HD: 'half day leave without pay',
  'PL_HD/LWP_HD': 'half day paid leave + half day without pay',
  A: 'absent',
  WO: 'weekly off',
  HL: 'holiday',
  '--': 'not judged yet',
};

const RULE_MEANING: Record<string, string> = {
  NO_APPLICATION: 'nothing tracked and no punch, and no leave applied for the day',
  LEAVE_NOT_APPROVED: 'nothing tracked and no punch; a leave was applied but not approved',
  WFH_UNAPPROVED: 'worked (time tracked) but no office punch and no approved WFH request',
  SHORT_DAY: 'tracked time under the full-day minimum, so it counts as a half day',
  UNDER_MIN: 'tracked time under the half-day minimum, so it counts as a full day of leave',
  HALF_DAY_SHORT: 'on a half-day leave, the working half was under the half-day minimum',
  LATE: 'late arrival after the monthly allowance of late marks was used up',
};

// ---------------------------------------------------------------------------
// Response shapes we read (only the fields used)
// ---------------------------------------------------------------------------

interface DayInsight {
  date: string;
  isFuture: boolean;
  isToday: boolean;
  shift: { name: string; start: string; end: string } | null;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; pendingMs: number; gapMs: number; invalidatedMs: number };
  blocks: Array<{ kind: string; startedAt: number; endedAt: number; durationMs: number; isOpen?: boolean; reason?: string; invalidated?: boolean }>;
  recentRejected: Array<{ requestedStart: number; requestedEnd: number; reason: string; decidedReason: string | null }>;
}

interface ReportDay {
  date: string;
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  invalidatedMs?: number;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  punchInMinute: number | null;
  punchOutMinute: number | null;
  shiftStatus: string;
  approvals: { approved: number; pending: number; rejected: number };
  screenshots?: { count: number };
  dayStatus: { kind: string; portion: string | null; label: string | null; shiftName: string | null; expectedFraction: number } | null;
  attendanceCode?: string | null;
  attendanceOverride?: { code?: string | null; reason?: string | null } | null;
  computedAttendanceCode?: string | null;
  attendanceRule?: { tag: string; penaltyDays: number } | null;
}

// ---------------------------------------------------------------------------
// Condensers (pure, tested)
// ---------------------------------------------------------------------------

export function condenseReportDay(d: ReportDay, tz: string) {
  const code = d.attendanceCode ?? d.computedAttendanceCode ?? null;
  const tracked = d.workedMs + d.meetingMs + d.manualMs;
  const isToday = d.date === todayKey(tz);
  return {
    date: d.date,
    day: fmtDay(d.date),
    ...(isToday ? { note: 'today, still in progress: hours so far, attendance not decided yet' } : {}),
    dayType: d.dayStatus ? [d.dayStatus.kind.toLowerCase().replace(/_/gu, ' '), d.dayStatus.portion?.toLowerCase(), d.dayStatus.label].filter(Boolean).join(' · ') : 'no shift',
    shift: d.dayStatus?.shiftName ?? null,
    totalCounted: fmtDuration(tracked),
    work: fmtDuration(d.workedMs),
    meetings: fmtDuration(d.meetingMs),
    approvedManual: fmtDuration(d.manualMs),
    ...(d.invalidatedMs ? { removedByReviewer: fmtDuration(d.invalidatedMs) } : {}),
    firstActivity: fmtClock(d.firstActivityMs, tz),
    lastActivity: fmtClock(d.lastActivityMs, tz),
    officePunchIn: minuteClock(d.punchInMinute),
    officePunchOut: minuteClock(d.punchOutMinute),
    arrival: d.shiftStatus.replace(/_/gu, ' '),
    attendance: isToday ? 'not decided yet' : code ? `${code} (${ATTENDANCE_CODE_MEANING[code] ?? 'code'})` : null,
    ...(d.attendanceOverride?.code ? { setByAdmin: `${d.attendanceOverride.code}${d.attendanceOverride.reason ? ` — ${d.attendanceOverride.reason}` : ''}` } : {}),
    ...(d.attendanceRule
      ? { ruleApplied: `${d.attendanceRule.tag}: ${RULE_MEANING[d.attendanceRule.tag] ?? 'attendance rule'} (costs ${d.attendanceRule.penaltyDays} day of leave)` }
      : {}),
    manualRequests: d.approvals,
    ...(d.screenshots ? { screenshots: d.screenshots.count } : {}),
  };
}

export function condenseDayInsight(d: DayInsight, tz: string) {
  const blocks = d.blocks.map((b) => ({
    what: b.kind.toLowerCase().replace(/_/gu, ' ') + (b.invalidated ? ' (removed by reviewer, not counted)' : '') + (b.isOpen ? ' (running now)' : ''),
    from: fmtClock(b.startedAt, tz),
    to: fmtClock(b.endedAt, tz),
    length: fmtDuration(b.durationMs),
    ...(b.reason ? { reason: b.reason.slice(0, 200) } : {}),
  }));
  // Short slivers say little; keep the picture readable.
  const shown = blocks.length > 40 ? blocks.filter((_, i) => d.blocks[i]!.durationMs >= 5 * 60_000).slice(0, 40) : blocks;
  return {
    date: d.date,
    day: fmtDay(d.date),
    ...(d.isToday ? { note: 'today, still in progress' } : {}),
    ...(d.isFuture ? { note: 'in the future' } : {}),
    shift: d.shift ? `${d.shift.name} ${d.shift.start}–${d.shift.end}` : 'no shift that day',
    firstActivity: fmtClock(d.firstActivityAt, tz),
    lastActivity: fmtClock(d.lastActivityAt, tz),
    totals: {
      work: fmtDuration(d.totals.workedMs),
      meetings: fmtDuration(d.totals.meetingMs),
      approvedManual: fmtDuration(d.totals.manualMs),
      counted: fmtDuration(d.totals.workedMs + d.totals.meetingMs + d.totals.manualMs),
      idleTrimmed: fmtDuration(d.totals.idleTrimmedMs),
      pendingManual: fmtDuration(d.totals.pendingMs),
      untrackedGaps: fmtDuration(d.totals.gapMs),
      ...(d.totals.invalidatedMs ? { removedByReviewer: fmtDuration(d.totals.invalidatedMs) } : {}),
    },
    timeline: shown,
    ...(blocks.length !== shown.length ? { timelineNote: `${blocks.length - shown.length} blocks under 5 minutes left out` } : {}),
    rejectedManualRequests: d.recentRejected.map((r) => ({
      from: fmtClock(r.requestedStart, tz),
      to: fmtClock(r.requestedEnd, tz),
      reason: r.reason.slice(0, 200),
      rejectionNote: r.decidedReason?.slice(0, 200) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const dateProp = (what: string) => ({ type: 'string', description: `${what}, as YYYY-MM-DD in the person's timezone.` });

export const SUPPORT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_day',
    description:
      "One day of the person's time in Timo, exactly as their dashboard shows it: shift, first and last activity, totals (work, meetings, approved manual time, idle trimmed, pending manual time, untracked gaps), the timeline of blocks with local times, attendance code with any rule that changed it, office punch in/out, and rejected manual-time requests. Use it whenever the person talks about a specific day's hours, gaps, late mark, half day, absent or missing time.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { date: dateProp('The day') },
      required: ['date'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_days',
    description:
      'A per-day summary over a range (at most 31 days): counted hours, office punch in/out, arrival (early / on time / late), attendance code and the rule behind it, day type (working, leave, holiday, weekly off) and manual-request counts. Use it for questions about a week or a month, how many late marks, or which days were cut.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { from: dateProp('First day'), to: dateProp('Last day (inclusive)') },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_manual_time_requests',
    description:
      "The person's manual-time requests (time they asked to add for work the app did not track): requested slot, reason, status (pending, approved, rejected, cancelled), who decided and the decision note. Optional date range; without one, the latest 25.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: ['string', 'null'], description: 'First day YYYY-MM-DD, or null.' },
        to: { type: ['string', 'null'], description: 'Last day YYYY-MM-DD, or null.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_leave',
    description:
      "The person's leave balance (days left, accrued, used) and their recent leave and work-from-home requests with status and dates.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_app_status',
    description:
      "The state of the person's Timo desktop app as last reported: when it was last seen, running/tracking state, version, platform and OS, screen-recording and accessibility permission state, launch at login, whether time is waiting to sync and any sync or update error. Use it for crashes, tracking stopping, time showing in the app but not on the dashboard, updates and permissions.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_my_tickets',
    description:
      "The person's support tickets: number, title, status, whose turn it is, and the last reply. Use it when they ask about an earlier complaint or 'any update', and before offering a ticket, to see if one is already open for the same problem.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'offer_ticket',
    description:
      'Put a support-ticket card in front of the person so an admin can act. Nothing is filed until the person presses Open ticket on the card (or adds it to their open ticket). Use it only when an admin has to do something the person cannot do themselves (fix data, approve, change a setting, investigate a bug) and only after you have looked at their data. Calling it again in the same conversation updates the same card. Screenshots the person sent in this conversation are attached automatically.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Ticket title, plain English, at most 70 characters, specific (what is wrong + the date). No names.' },
        category: { type: 'string', enum: [...TICKET_CATEGORIES], description: 'TIMO_APP desktop app; TIME_ATTENDANCE hours, gaps, late, half day, absent, manual time; LEAVE_PAYROLL leave, WFH, holidays, salary; ACCESS sign in, permissions; OTHER.' },
        details: {
          type: 'string',
          description:
            'For the admin, in English: what the person reports, then what you found in their data (dates, numbers, app state), then what you think the admin needs to do. Plain sentences, no markdown headings.',
        },
        related_ticket_number: { type: ['integer', 'null'], description: 'Their open ticket this is the same problem as, or null.' },
      },
      required: ['subject', 'category', 'details', 'related_ticket_number'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

class ToolInputError extends Error {}

function needDate(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (!isDateKey(v)) throw new ToolInputError(`${key} must be a real date as YYYY-MM-DD`);
  return v;
}

async function getDay(p: SupportPerson, input: Record<string, unknown>) {
  const date = needDate(input, 'date');
  const [day, report] = await Promise.all([
    selfGet<DayInsight>(p, `/v1/insights/day?date=${date}`),
    selfGet<{ days: ReportDay[] }>(p, `/v1/reports/me?from=${date}&to=${date}`),
  ]);
  const row = report.days.find((d) => d.date === date);
  return { ...condenseDayInsight(day, p.timezone), attendanceForTheDay: row ? condenseReportDay(row, p.timezone) : null };
}

async function getDays(p: SupportPerson, input: Record<string, unknown>) {
  const from = needDate(input, 'from');
  const to = needDate(input, 'to');
  if (to < from) throw new ToolInputError('to is before from');
  if (daysBetween(from, to) > 30) throw new ToolInputError('at most 31 days at a time');
  const report = await selfGet<{ days: ReportDay[] }>(p, `/v1/reports/me?from=${from}&to=${to}`);
  const days = report.days.map((d) => condenseReportDay(d, p.timezone));
  const late = days.filter((d) => d.arrival === 'late').length;
  const cut = days.filter((d) => 'ruleApplied' in d).length;
  return { from, to, summary: { daysShown: days.length, lateArrivals: late, daysCutByRules: cut }, days };
}

async function getManualTimeRequests(p: SupportPerson, input: Record<string, unknown>) {
  const from = input.from == null ? null : needDate(input, 'from');
  const to = input.to == null ? null : needDate(input, 'to');
  const rows = await prisma.manualTimeRequest.findMany({
    where: {
      userId: p.userId,
      // Padded a day each side for the timezone; trimmed to local days below.
      ...(from ? { requestedEnd: { gt: new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000) } } : {}),
      ...(to ? { requestedStart: { lt: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000) } } : {}),
    },
    orderBy: { requestedStart: 'desc' },
    take: 60,
    select: {
      requestedStart: true,
      requestedEnd: true,
      reason: true,
      status: true,
      decidedAt: true,
      decidedReason: true,
      autoApproved: true,
      createdAt: true,
      decidedBy: { select: { name: true } },
      approver: { select: { name: true } },
    },
  });
  const inRange = rows.filter((r) => {
    const day = dateKeyInTimeZone(r.requestedStart, p.timezone);
    return (!from || day >= from) && (!to || day <= to);
  });
  return {
    requests: inRange.slice(0, 25).map((r) => ({
      day: fmtDay(dateKeyInTimeZone(r.requestedStart, p.timezone)),
      slot: `${fmtClock(r.requestedStart.getTime(), p.timezone)}–${fmtClock(r.requestedEnd.getTime(), p.timezone)}`,
      length: fmtDuration(r.requestedEnd.getTime() - r.requestedStart.getTime()),
      reason: r.reason.slice(0, 200),
      status: r.status.toLowerCase() + (r.autoApproved ? ' (auto-approved)' : ''),
      approver: r.approver?.name ?? null,
      decidedBy: r.decidedBy?.name ?? null,
      decidedOn: r.decidedAt ? fmtDay(dateKeyInTimeZone(r.decidedAt, p.timezone)) : null,
      decisionNote: r.decidedReason?.slice(0, 200) ?? null,
      sentOn: fmtDay(dateKeyInTimeZone(r.createdAt, p.timezone)),
    })),
  };
}

async function getLeave(p: SupportPerson) {
  const [balance, leave, wfh] = await Promise.all([
    selfGet<{ leftDays: number; balance: { accruedDays: number; consumedDays: number; adjustedDays: number; asOf: string } }>(p, '/v1/leave/me/balance'),
    selfGet<{ requests: Array<{ kind: string; startDate: string; endDate: string; portion: string; chargedDays: number; reason: string; status: string; decidedByName: string | null; createdAt: string }> }>(p, '/v1/leave/me/requests'),
    prisma.wfhRequest.findMany({
      where: { userId: p.userId },
      orderBy: { startDate: 'desc' },
      take: 15,
      select: { startDate: true, endDate: true, reason: true, status: true },
    }),
  ]);
  return {
    balance: {
      daysLeft: balance.leftDays,
      accrued: balance.balance.accruedDays,
      used: balance.balance.consumedDays,
      adjustedByAdmin: balance.balance.adjustedDays,
      asOf: balance.balance.asOf,
    },
    leaveRequests: leave.requests.slice(0, 15).map((r) => ({
      kind: r.kind.toLowerCase(),
      from: r.startDate,
      to: r.endDate,
      portion: r.portion.toLowerCase().replace(/_/gu, ' '),
      days: r.chargedDays,
      status: r.status.toLowerCase(),
      decidedBy: r.decidedByName,
      reason: r.reason.slice(0, 160),
    })),
    wfhRequests: wfh.map((w) => ({
      from: w.startDate.toISOString().slice(0, 10),
      to: w.endDate.toISOString().slice(0, 10),
      status: w.status.toLowerCase(),
      reason: w.reason.slice(0, 160),
    })),
  };
}

async function getAppStatus(p: SupportPerson) {
  const u = await prisma.user.findUnique({
    where: { id: p.userId },
    select: {
      ...SYNC_HEALTH_SELECT,
      agentState: true,
      agentScreenPermissionStatus: true,
      agentScreenCaptureHealth: true,
      agentAccessibilityTrusted: true,
      agentLaunchAtLoginState: true,
      agentInstallScope: true,
      agentUpdateError: true,
    },
  });
  if (!u) return { error: 'person not found' };
  if (!u.agentLastSeenAt && !u.agentVersion) {
    return { installed: false, note: 'Timo has never reported from a computer for this person: the desktop app is not installed or never signed in.' };
  }
  const now = Date.now();
  const sync = classifySyncHealth(u, new Date(now));
  const seenAgo = u.agentLastSeenAt ? now - u.agentLastSeenAt.getTime() : null;
  const reportAge = sync.reportAgeMs;
  const stale = reportAge != null && reportAge > 15 * 60_000;
  return {
    ...(stale ? { note: `The app has not reported for ${fmtDuration(reportAge)}: it is closed, asleep or offline. What follows is as of its last report.` } : {}),
    lastSeen: u.agentLastSeenAt
      ? `${fmtDay(dateKeyInTimeZone(u.agentLastSeenAt, p.timezone))} ${fmtClock(u.agentLastSeenAt.getTime(), p.timezone)} (${fmtDuration(seenAgo)} ago)`
      : null,
    state: u.agentState.toLowerCase(),
    version: u.agentVersion,
    platform: [u.agentPlatform, u.agentOsVersion, u.agentArch].filter(Boolean).join(' '),
    screenRecordingPermission: u.agentScreenPermissionStatus,
    screenCapture: u.agentScreenCaptureHealth,
    accessibilityPermission: u.agentAccessibilityTrusted,
    launchAtLogin: u.agentLaunchAtLoginState,
    ...(u.agentInstallScope ? { installScope: u.agentInstallScope } : {}),
    ...(u.agentUpdateError ? { updateError: u.agentUpdateError.slice(0, 200) } : {}),
    sync: {
      status: (sync.status === 'UNKNOWN' ? sync.lastKnownStatus ?? 'UNKNOWN' : sync.status).toLowerCase(),
      entriesWaitingToUpload: sync.pending ?? 0,
      ...(u.agentSyncOldestPendingAt && (sync.pending ?? 0) > 0
        ? { oldestWaitingSince: `${fmtDay(dateKeyInTimeZone(u.agentSyncOldestPendingAt, p.timezone))} ${fmtClock(u.agentSyncOldestPendingAt.getTime(), p.timezone)}` }
        : {}),
      lastError: sync.lastErrorLabel ?? sync.lastError,
    },
  };
}

async function getMyTickets(p: SupportPerson) {
  const rows = await prisma.ticket.findMany({
    where: { requesterId: p.userId },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      number: true,
      subject: true,
      status: true,
      category: true,
      createdAt: true,
      assignee: { select: { name: true } },
      events: {
        // Public replies and status changes that carried a note (a question, a resolution).
        where: { kind: { in: ['COMMENT', 'STATUS'] }, body: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { kind: true, body: true, createdAt: true, actor: { select: { name: true } }, actorId: true },
      },
    },
  });
  return {
    tickets: rows.map((t) => {
      const last = t.events[0];
      return {
        number: t.number,
        title: t.subject,
        status: t.status.toLowerCase().replace(/_/gu, ' '),
        category: t.category,
        opened: fmtDay(dateKeyInTimeZone(t.createdAt, p.timezone)),
        assignedTo: t.assignee?.name ?? null,
        lastReply: last
          ? {
              by: last.actorId === p.userId ? 'the person' : last.actor?.name ?? 'admin',
              on: fmtDay(dateKeyInTimeZone(last.createdAt, p.timezone)),
              text: (last.body ?? '').slice(0, 300),
            }
          : null,
      };
    }),
  };
}

function offerTicket(state: ToolRunState, input: Record<string, unknown>) {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const details = typeof input.details === 'string' ? input.details.trim() : '';
  const category = TICKET_CATEGORIES.includes(input.category as TicketCategory) ? (input.category as TicketCategory) : 'OTHER';
  if (subject.length < 3) throw new ToolInputError('subject is too short');
  if (details.length < 10) throw new ToolInputError('details are too short');
  const related = typeof input.related_ticket_number === 'number' ? input.related_ticket_number : null;
  state.offer = { subject, category, details, relatedTicketNumber: related };
  return {
    ok: true,
    note: 'The ticket card will be sent right after your reply. Tell the person to check it and press Open ticket (or add it to their open ticket). Do not say it is already filed.',
  };
}

/** Run one tool call. Errors come back as text for the model, never thrown. */
export async function runSupportTool(
  p: SupportPerson,
  state: ToolRunState,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  try {
    let out: unknown;
    switch (name) {
      case 'get_day':
        out = await getDay(p, args);
        break;
      case 'get_days':
        out = await getDays(p, args);
        break;
      case 'get_manual_time_requests':
        out = await getManualTimeRequests(p, args);
        break;
      case 'get_leave':
        out = await getLeave(p);
        break;
      case 'get_app_status':
        out = await getAppStatus(p);
        break;
      case 'get_my_tickets':
        out = await getMyTickets(p);
        break;
      case 'offer_ticket':
        out = offerTicket(state, args);
        break;
      default:
        return { content: `Unknown tool ${name}.`, isError: true };
    }
    return { content: JSON.stringify(out), isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) return { content: `Invalid input: ${err.message}.`, isError: true };
    if (err instanceof SelfApiError) return { content: `Could not read that (${err.code}).`, isError: true };
    return { content: 'Could not read that right now.', isError: true };
  }
}

/** Today and the last week, as context for "kal", "Monday", "last week". */
export function dateContext(timeZone: string, now = new Date()): { today: string; label: string } {
  const today = todayKey(timeZone, now);
  return { today, label: `${fmtDay(today)}, ${fmtClock(now.getTime(), timeZone)} (${timeZone})` };
}

export { addDays };

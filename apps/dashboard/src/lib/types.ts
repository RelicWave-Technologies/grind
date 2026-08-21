/**
 * Wire types for the dashboard's data endpoints. These mirror the server-
 * side shapes in apps/api/src/insights/day.ts and apps/api/src/routes/admin.ts
 * — kept here as plain TS types because the dashboard doesn't pull
 * @grind/db (no Prisma in the browser bundle).
 */

export type BlockKind = 'WORK' | 'MEETING' | 'MANUAL' | 'IDLE_TRIMMED' | 'PENDING' | 'GAP';

export interface DayBlock {
  kind: BlockKind;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  taskSummary?: string | null;
  notes?: string | null;
  isOpen?: boolean;
  attendeeIds?: string[];
  /** ManualTimeRequest id for PENDING and approved MANUAL blocks. */
  requestId?: string;
  /** PENDING blocks only: the request reason (shown + editable inline). */
  reason?: string;
}

export interface RejectedRequest {
  id: string;
  requestedStart: number;
  requestedEnd: number;
  reason: string;
  decidedReason: string | null;
  larkTaskGuid: string | null;
  taskSummary?: string | null;
}

export interface ActivityHeatmap {
  bucketMs: number;
  buckets: Array<number | null>;
  sampleCounts: number[];
}

export interface AppUsageEntry {
  app: string;
  appBundle: string | null;
  domain?: string | null;
  sourceApp?: string | null;
  sourceAppBundle?: string | null;
  iconUrl?: string | null;
  minutes: number;
  keystrokes: number;
  clicks: number;
}

export interface AppUsageInsight {
  totalMinutes: number;
  topApps: AppUsageEntry[];
}

export interface DayInsight {
  date: string;
  timezone: string;
  /** True local midnight-to-midnight bounds. Optional while older APIs roll out. */
  calendarDayStart?: number;
  calendarDayEnd?: number;
  /** Caller-selected review bounds used by editable blocks and gap totals. */
  dayStart: number;
  dayEnd: number;
  isFuture: boolean;
  isToday: boolean;
  /** Assigned shift marker, or null on an unassigned/day-off calendar day. */
  shift: {
    name: string;
    start: string;
    end: string;
    startedAt?: number;
    endedAt?: number;
  } | null;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; pendingMs: number; gapMs: number; invalidatedMs?: number };
  /** Single sorted partition incl. PENDING blocks — no separate overlay. */
  blocks: DayBlock[];
  recentRejected: RejectedRequest[];
  activity?: ActivityHeatmap;
  /** Full calendar-day activity. Falls back to `activity` against older APIs. */
  fullDayActivity?: ActivityHeatmap;
  appUsage?: AppUsageInsight;
}

// ---------------------------------------------------------------------------
// Workspace directory (for the AttendeePicker)
// ---------------------------------------------------------------------------

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
}

// ---------------------------------------------------------------------------
// Manual-time approval queue
// ---------------------------------------------------------------------------

export type MtrStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface MtrUserSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export type TriageVerdict = 'approve' | 'review' | 'reject';

export interface TriageSignal {
  id: string;
  text: string;
  weight: number;
}

export interface TriageResult {
  verdict: TriageVerdict;
  confidence: number;
  signals: TriageSignal[];
  headline: string;
}

export interface ManualTimeRequest {
  id: string;
  status: MtrStatus;
  requestedStart: string; // ISO
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  taskSummary?: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  user: MtrUserSummary;
  approver?: MtrUserSummary | null;
  /** AI-assist verdict for PENDING rows. Null for already-decided ones. */
  triage?: TriageResult | null;
}

export interface DecideResult {
  status: MtrStatus;
  timeEntryId: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  noop: 'already_decided' | 'cancelled' | 'forbidden' | 'self_approval_forbidden' | null;
}

// ---------------------------------------------------------------------------
// Timesheets matrix
// ---------------------------------------------------------------------------

export interface TimesheetCell {
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  invalidatedMs: number;
  totalMs: number;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  activitySampleCount: number;
}

export interface TimesheetUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
}

// ---------------------------------------------------------------------------
// Anti-cheat flags
// ---------------------------------------------------------------------------

export type FlagType = 'IMPOSSIBLE_RATE' | 'METRONOMIC' | 'LINEAR_MOUSE' | 'SINGLE_CHANNEL' | 'JIGGLER';
export type FlagStatus = 'OPEN' | 'RESOLVED';
export type FlagResolution = 'DISMISSED' | 'CONFIRMED' | 'TIME_INVALIDATED';

export interface ActivityFlag {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  type: FlagType;
  windowStart: string;
  windowEnd: string;
  riskScore: number;
  evidence: Record<string, number>;
  /** AI-assist explanation (M17). */
  explanation?: { headline: string; detail: string };
  status: FlagStatus;
  resolution: FlagResolution | null;
  resolvedById: string | null;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
}

export type ActivityRoleTitle = 'DEVELOPER' | 'DESIGNER' | 'SALES' | 'OTHER';

// ---------------------------------------------------------------------------
// Admin CRUD: Teams + User patches
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  managers: Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: 'ADMIN' | 'MANAGER' | 'MEMBER';
    teamId: string | null;
  }>;
  managerIds: string[];
  managerCount: number;
  /** Compatibility alias for old API clients; prefer managers/managerIds. */
  managerId: string | null;
  memberCount: number;
  createdAt: string;
}

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface DaySchedule {
  start: string; // HH:MM
  end: string;   // HH:MM
}

export type ShiftSchedule = Record<WeekdayKey, DaySchedule | null>;

export interface Shift {
  id: string;
  workspaceId: string;
  name: string;
  schedule: ShiftSchedule;
  bufferMin: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimesheetMatrix {
  from: string;
  to: string;
  tz: string;
  scope: 'self' | 'team' | 'workspace';
  days: string[];
  users: TimesheetUser[];
  cells: Record<string, Record<string, TimesheetCell>>;
}

// ---------------------------------------------------------------------------
// Leave, company holidays and balances
// ---------------------------------------------------------------------------

export type LeavePortion = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';
export type LeaveKind = 'PAID' | 'UNPAID';
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface HolidayDto {
  id: string;
  date: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  createdAt: string;
}

export interface LeaveRequestDto {
  id: string;
  userId: string;
  userName: string;
  kind: LeaveKind;
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  chargedDays: number;
  reason: string;
  status: LeaveRequestStatus;
  decisionSource: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  larkInstanceCode: string | null;
  createdAt: string;
}

export interface LeaveBalance {
  balanceDays: number;
  accruedDays: number;
  consumedDays: number;
  adjustedDays: number;
}

export interface LeaveStatementRow {
  kind: 'ACCRUAL' | 'CONSUMPTION' | 'ADJUSTMENT';
  days: number;
  effectiveOn: string;
  reason: string | null;
}

export interface LeaveBalanceResponse {
  balance: LeaveBalance & { userId: string; asOf: string };
  statement: LeaveStatementRow[];
}

export interface LeaveAwayDay {
  date: string;
  kind: 'PAID_LEAVE' | 'UNPAID_LEAVE';
  portion: LeavePortion | null;
  label: string | null;
}

export interface LeaveCalendarResponse {
  from: string;
  to: string;
  tz: string;
  users: Array<{ id: string; name: string; avatarUrl: string | null; teamId: string | null }>;
  away: Record<string, LeaveAwayDay[]>;
  holidays: HolidayDto[];
}

export interface LeaveQuoteResponse {
  chargedDays: number;
  balanceDays: number;
  balanceAfterDays: number;
  sufficient: boolean;
  days: Array<{ date: string; kind: string; portion: LeavePortion | null; label: string | null }>;
}

export interface LeavePolicyResponse {
  policy: {
    monthlyAccrualDays: number;
    carryForward: boolean;
    carryForwardCapDays: number | null;
    allowNegativeBalance: boolean;
    accrueOnJoinMonth: boolean;
    updatedAt: string;
  };
  approvalGateway: string;
  decidesInTimo: boolean;
}

export interface LeaveBalanceRow {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  teamName: string | null;
  /** null = inherits the workspace policy. */
  accrualDays: number | null;
  effectiveAccrualDays: number;
  lastSaturdayOff: boolean | null;
  effectiveLastSaturdayOff: boolean;
  accrualStart: string;
  joinedOnSet: boolean;
  balanceDays: number;
  accruedDays: number;
  consumedDays: number;
  adjustedDays: number;
}

export interface LeaveBalancesResponse {
  asOf: string;
  policy: LeavePolicyResponse['policy'];
  rows: LeaveBalanceRow[];
}

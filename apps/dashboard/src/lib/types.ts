/**
 * Wire types for the dashboard's data endpoints. These mirror the server-
 * side shapes in apps/api/src/insights/day.ts and apps/api/src/routes/admin.ts
 * — kept here as plain TS types because the dashboard doesn't pull
 * @grind/db (no Prisma in the browser bundle).
 */

export type BlockKind = 'WORK' | 'MEETING' | 'MANUAL' | 'IDLE_TRIMMED' | 'GAP';

export interface DayBlock {
  kind: BlockKind;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  notes?: string | null;
  isOpen?: boolean;
  attendeeIds?: string[];
}

export interface PendingOverlay {
  id: string;
  startedAt: number;
  endedAt: number;
  reason: string;
  larkTaskGuid: string | null;
  attendeeIds?: string[];
}

export interface RejectedRequest {
  id: string;
  requestedStart: number;
  requestedEnd: number;
  reason: string;
  decidedReason: string | null;
  larkTaskGuid: string | null;
}

export interface ActivityHeatmap {
  bucketMs: number;
  buckets: Array<number | null>;
  sampleCounts: number[];
}

export interface DayInsight {
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
  pendingOverlay: PendingOverlay[];
  recentRejected: RejectedRequest[];
  activity?: ActivityHeatmap;
}

// ---------------------------------------------------------------------------
// Workspace directory (for the AttendeePicker)
// ---------------------------------------------------------------------------

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
}

// ---------------------------------------------------------------------------
// Manual-time approval queue
// ---------------------------------------------------------------------------

export type MtrStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface MtrUserSummary {
  id: string;
  name: string;
  email: string;
}

export interface ManualTimeRequest {
  id: string;
  status: MtrStatus;
  requestedStart: string; // ISO
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  user: MtrUserSummary;
}

export interface DecideResult {
  status: MtrStatus;
  timeEntryId: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  noop: 'already_decided' | 'cancelled' | 'forbidden' | null;
}

// ---------------------------------------------------------------------------
// Timesheets matrix
// ---------------------------------------------------------------------------

export interface TimesheetCell {
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  totalMs: number;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
}

export interface TimesheetUser {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
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
  user: { id: string; name: string; email: string };
  type: FlagType;
  windowStart: string;
  windowEnd: string;
  riskScore: number;
  evidence: Record<string, number>;
  status: FlagStatus;
  resolution: FlagResolution | null;
  resolvedById: string | null;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Admin CRUD: Teams + User patches
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
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

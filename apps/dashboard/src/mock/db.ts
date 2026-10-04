/**
 * The mock's in-memory store. Everything list-shaped lives here; tracked time
 * is generated deterministically per person-day (see activity.ts) and only the
 * edits to it are stored, so the snapshot stays small.
 *
 * The store is persisted to sessionStorage after every write, so a reload,
 * an HMR full-reload or a role switch keeps the session's edits. "Reset data"
 * in the dev panel throws it away and reseeds.
 */
import type {
  ActivityRoleTitle,
  ApiTokenScope,
  AttendanceOverrideCode,
  MonitoringSettingsRiskLevel,
  MonitoringSettingsScope,
  Role,
} from '@grind/types';
import type { ShiftSchedule } from '@grind/types/shifts';
import type {
  FlagResolution,
  FlagStatus,
  FlagType,
  LeaveKind,
  LeavePortion,
  LeaveRequestStatus,
  MtrStatus,
  TriageResult,
} from '../lib/types';
import type { AgentDef, Discipline, Persona } from './people';

export interface DbUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  activityRoleTitle: ActivityRoleTitle;
  teamId: string | null;
  managerId: string | null;
  avatarUrl: string | null;
  shiftId: string | null;
  shiftAssignedAt: number | null;
  createdAt: number;
  birthDate: string | null;
  deactivatedAt: number | null;
  provisioningStatus: 'PENDING' | 'ACTIVE';
  persona: Persona;
  discipline: Discipline;
  agent: AgentDef;
  screenshotIntervalMin: 1 | 2 | 3 | null;
  idleThresholdMin: number | null;
  idleWarningSeconds: number | null;
  leaveAccrualDays: number | null;
  leaveLastSaturdayOff: boolean | null;
  /** YYYY-MM-DD when explicitly set; otherwise accrual starts at createdAt. */
  joinedOn: string | null;
}

export interface DbTeam {
  id: string;
  name: string;
  managerIds: string[];
  createdAt: number;
}

export interface DbShift {
  id: string;
  name: string;
  schedule: ShiftSchedule;
  bufferMin: number;
  createdAt: number;
  updatedAt: number;
}

export interface DbRequest {
  id: string;
  clientUuid: string;
  userId: string;
  approverId: string | null;
  larkTaskGuid: string | null;
  taskSummary: string | null;
  start: number;
  end: number;
  reason: string;
  status: MtrStatus;
  autoApproved: boolean;
  decidedAt: number | null;
  decidedReason: string | null;
  createdAt: number;
  attendeeIds: string[];
  timeEntryId: string | null;
  triage: TriageResult | null;
}

export interface DbManualEntry {
  id: string;
  userId: string;
  requestId: string | null;
  start: number;
  end: number;
  larkTaskGuid: string | null;
  notes: string | null;
  attendeeIds: string[];
}

export interface EntryPatch {
  larkTaskGuid?: string | null;
  notes?: string | null;
  attendeeIds?: string[];
  deleted?: boolean;
}

export interface DbFlag {
  id: string;
  userId: string;
  type: FlagType;
  windowStart: number;
  windowEnd: number;
  riskScore: number;
  evidence: Record<string, number>;
  explanation?: { headline: string; detail: string };
  status: FlagStatus;
  resolution: FlagResolution | null;
  resolvedById: string | null;
  resolvedAt: number | null;
  resolvedNote: string | null;
  createdAt: number;
}

export interface DbToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  createdById: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface DbHoliday {
  id: string;
  date: string;
  name: string;
  teamId: string | null;
  createdAt: number;
}

export interface DbLeaveRequest {
  id: string;
  userId: string;
  kind: LeaveKind;
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  chargedDays: number;
  reason: string;
  status: LeaveRequestStatus;
  decisionSource: 'LARK_APPROVAL' | 'DASHBOARD' | 'REQUESTER_CANCEL' | null;
  decidedAt: number | null;
  decidedById: string | null;
  larkInstanceCode: string | null;
  createdAt: number;
}

export interface DbLeaveAdjustment {
  id: string;
  userId: string;
  days: number;
  effectiveOn: string;
  reason: string;
  createdAt: number;
}

export interface DbAudit {
  id: string;
  scope: MonitoringSettingsScope;
  riskLevel: MonitoringSettingsRiskLevel;
  actorId: string | null;
  targetUserId: string | null;
  previousScreenshotIntervalMin: number | null;
  previousIdleThresholdMin: number | null;
  previousIdleWarningSeconds: number | null;
  nextScreenshotIntervalMin: number | null;
  nextIdleThresholdMin: number | null;
  nextIdleWarningSeconds: number | null;
  reason: string | null;
  createdAt: number;
}

export interface DbOverride {
  userId: string;
  date: string;
  code: AttendanceOverrideCode;
  reason: string;
  setById: string | null;
  setAt: number;
  computedCode: string | null;
}

export interface DbOverrideHistory {
  userId: string;
  date: string;
  code: AttendanceOverrideCode | null;
  reason: string;
  computedCode: string | null;
  setAt: number;
  setById: string | null;
}

export interface DbPayrollRun {
  id: string;
  month: string;
  runType: 'APPROVAL_REMINDER' | 'PAYROLL_SHEET';
  scheduledFor: number;
  status: 'SENT' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  sentCount: number;
  skippedNoLarkCount: number;
  skippedUnassignedCount: number;
  failedCount: number;
  createdAt: number;
}

export interface MockDb {
  version: number;
  seedDay: string;
  /** Epoch ms the store was generated; "today" is laid out around it. */
  seededAt: number;
  workspaceCreatedAt: number;
  users: DbUser[];
  teams: DbTeam[];
  shifts: DbShift[];
  requests: DbRequest[];
  manualEntries: DbManualEntry[];
  entryPatches: Record<string, EntryPatch>;
  flags: DbFlag[];
  tokens: DbToken[];
  holidays: DbHoliday[];
  leaveRequests: DbLeaveRequest[];
  leaveAdjustments: DbLeaveAdjustment[];
  leavePolicy: {
    monthlyAccrualDays: number;
    carryForward: boolean;
    carryForwardCapDays: number | null;
    allowNegativeBalance: boolean;
    accrueOnJoinMonth: boolean;
    updatedAt: number;
  };
  workspacePolicy: {
    captureApps: boolean;
    captureTitles: boolean;
    captureUrls: boolean;
    retentionDaysScreenshots: number;
    defaultScreenshotIntervalMin: 1 | 2 | 3;
    defaultIdleThresholdMin: number;
    createdAt: number;
    updatedAt: number;
  };
  payrollPolicy: {
    halfDayLowerMin: number;
    halfDayUpperMin: number;
    fullDayLowerMin: number;
    fullDayUpperMin: number;
    monthlyLowerMin: number;
    timezone: string;
    approvalReminderDays: number[];
    approvalReminderTime: string;
    payrollSheetSendDay: number;
    payrollSheetSendTime: string;
    sendPayrollSheetTo: 'all_admins';
    createdAt: number;
    updatedAt: number;
  };
  payrollRuns: DbPayrollRun[];
  audits: DbAudit[];
  overrides: DbOverride[];
  overrideHistory: DbOverrideHistory[];
}

export const DB_VERSION = 4;
const STORAGE_KEY = 'timo.mock.db';

let current: MockDb | null = null;
let seeder: (() => MockDb) | null = null;
/** Bumped on every write; derived-data caches key on it. */
let revision = 0;

export function registerSeeder(fn: () => MockDb): void {
  seeder = fn;
}

export function dbRevision(): number {
  return revision;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function load(todayKey: string): MockDb | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MockDb;
    // Fixtures are relative to the day they were seeded; a new day reseeds.
    if (parsed.version !== DB_VERSION || parsed.seedDay !== todayKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getDb(todayKey: string): MockDb {
  if (current && current.seedDay === todayKey) return current;
  current = load(todayKey);
  if (!current) {
    if (!seeder) throw new Error('mock: no seeder registered');
    current = seeder();
    persist();
  }
  revision += 1;
  return current;
}

/** Call after every mutation. */
export function persist(): void {
  revision += 1;
  const s = storage();
  if (!s || !current) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Quota or private mode — the session still works in memory.
  }
}

export function resetDb(): void {
  current = null;
  revision += 1;
  storage()?.removeItem(STORAGE_KEY);
}

/** Serialised copy of the current store (self-test snapshots). */
export function exportDb(): string | null {
  return current ? JSON.stringify(current) : null;
}

export function importDb(json: string): void {
  current = JSON.parse(json) as MockDb;
  persist();
}

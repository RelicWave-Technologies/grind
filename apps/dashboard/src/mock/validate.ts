/**
 * Dev check: responses that have a zod schema in @grind/types are validated
 * as they leave the mock, so a fixture that drifts from the real contract is
 * reported in the console instead of rendering subtly wrong.
 *
 * Schemas are used structurally (no direct zod import — the dashboard does not
 * depend on zod itself; @grind/types does).
 */
import {
  AttendanceOverrideDtoSchema,
  AttendanceOverrideHistoryResponseSchema,
  HolidayDtoSchema,
  LeaveRequestDtoSchema,
  ManualTimeRequestDto,
  MemberReportDayAppsResponseSchema,
  MemberReportDayScreenshotsResponseSchema,
  MemberReportsMeResponseSchema,
  MonitoringSettingsAuditListResponse,
  PayrollPolicyDto,
  SelfProfileResponseSchema,
  ShiftDtoSchema,
  TeamMemberReportsResponseSchema,
  TeamMemberSettingsDtoSchema,
  TeamReportsResponseSchema,
  TeamReportsSummaryResponseSchema,
  TeamSettingsResponseSchema,
  UserDto,
  WorkspacePolicyDto,
} from '@grind/types';

interface Issue {
  path: Array<string | number>;
  message: string;
}

interface Schema {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: Issue[] } };
}

type Check = (body: unknown) => Issue[];

const one =
  (schema: Schema): Check =>
  (body) => {
    const r = schema.safeParse(body);
    return r.success ? [] : r.error.issues;
  };

/** `{ [key]: T[] }` — checks each item against the item schema. */
const listOf =
  (key: string, schema: Schema): Check =>
  (body) => {
    const items = (body as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(items)) return [{ path: [key], message: 'expected an array' }];
    for (let i = 0; i < items.length; i++) {
      const r = schema.safeParse(items[i]);
      if (!r.success) return r.error.issues.map((x) => ({ ...x, path: [key, i, ...x.path] }));
    }
    return [];
  };

const field =
  (key: string, schema: Schema): Check =>
  (body) => {
    const r = schema.safeParse((body as Record<string, unknown> | null)?.[key]);
    return r.success ? [] : r.error.issues.map((x) => ({ ...x, path: [key, ...x.path] }));
  };

const CHECKS: Record<string, Check> = {
  'GET /v1/auth/me': field('user', UserDto),
  'GET /v1/profile/me': one(SelfProfileResponseSchema),
  'GET /v1/time-requests': listOf('requests', ManualTimeRequestDto),
  'POST /v1/time-requests': one(ManualTimeRequestDto),
  'PATCH /v1/time-requests/:id': one(ManualTimeRequestDto),
  'POST /v1/time-requests/:id/cancel': one(ManualTimeRequestDto),
  'GET /v1/admin/manual-time-requests': listOf('requests', ManualTimeRequestDto),
  'GET /v1/reports/me': one(MemberReportsMeResponseSchema),
  'GET /v1/reports/me/day-apps': one(MemberReportDayAppsResponseSchema),
  'GET /v1/reports/me/day-screenshots': one(MemberReportDayScreenshotsResponseSchema),
  'GET /v1/reports/team/summary': one(TeamReportsSummaryResponseSchema),
  'GET /v1/reports/team': one(TeamReportsResponseSchema),
  'GET /v1/reports/team/member': one(TeamMemberReportsResponseSchema),
  'GET /v1/reports/team/member/day-apps': one(MemberReportDayAppsResponseSchema),
  'GET /v1/reports/team/member/day-screenshots': one(MemberReportDayScreenshotsResponseSchema),
  'GET /v1/reports/attendance-override/history': one(AttendanceOverrideHistoryResponseSchema),
  'PUT /v1/reports/attendance-override': one(AttendanceOverrideDtoSchema),
  'GET /v1/admin/team-member-settings': one(TeamSettingsResponseSchema),
  'PATCH /v1/admin/team-member-settings/:id': one(TeamMemberSettingsDtoSchema),
  'GET /v1/admin/workspace-policy': one(WorkspacePolicyDto),
  'PATCH /v1/admin/workspace-policy': one(WorkspacePolicyDto),
  'GET /v1/admin/payroll/policy': one(PayrollPolicyDto),
  'PATCH /v1/admin/payroll/policy': one(PayrollPolicyDto),
  'GET /v1/admin/monitoring-settings-audits': one(MonitoringSettingsAuditListResponse),
  'GET /v1/admin/shifts': listOf('shifts', ShiftDtoSchema),
  'POST /v1/admin/shifts': one(ShiftDtoSchema),
  'PATCH /v1/admin/shifts/:id': one(ShiftDtoSchema),
  'GET /v1/leave/me/requests': listOf('requests', LeaveRequestDtoSchema),
  'POST /v1/admin/leave/holidays': one(HolidayDtoSchema),
};

export function validatedRoutes(): string[] {
  return Object.keys(CHECKS);
}

/** A short description of the first few issues, or null when valid / unchecked. */
export function checkResponse(method: string, pattern: string, body: unknown): string | null {
  const check = CHECKS[`${method} ${pattern}`];
  if (!check) return null;
  const issues = check(body);
  if (!issues.length) return null;
  return issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

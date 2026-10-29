import type { Role } from './auth';

export const PERMISSIONS = [
  'profile.self.read',
  'reports.self.read',
  'reports.team.read',
  'reports.workspace.read',
  'time.self.edit',
  'time.team.edit',
  'people.read',
  'people.manage',
  'attendance.correct',
  'teams.read',
  'teams.manage',
  'team.settings.manage',
  'shifts.read',
  'shifts.manage',
  'policy.manage',
  'approvals.self.read',
  'approvals.team.decide',
  'approvals.workspace.decide',
  'flags.team.review',
  'flags.workspace.review',
  'overview.read',
  'api-tokens.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MEMBER_CAPABILITIES = [
  'profile.self.read',
  'reports.self.read',
  'time.self.edit',
  'approvals.self.read',
] as const satisfies readonly Permission[];

const MANAGER_CAPABILITIES = [
  ...MEMBER_CAPABILITIES,
  'reports.team.read',
  'time.team.edit',
  'people.read',
  'teams.read',
  'team.settings.manage',
  'shifts.read',
  'approvals.team.decide',
  'flags.team.review',
  'overview.read',
  'attendance.correct',
] as const satisfies readonly Permission[];

/**
 * HR runs the People tab — adds, edits, activates and suspends people (never an
 * admin or another HR, and never into either role) — and reads every report and
 * download. It does not correct attendance, decide approvals, or touch
 * settings, policy, shifts, teams or integrations.
 */
const HR_CAPABILITIES = [
  ...MEMBER_CAPABILITIES,
  'reports.team.read',
  'reports.workspace.read',
  'people.read',
  'people.manage',
  'teams.read',
  'shifts.read',
] as const satisfies readonly Permission[];

export const ROLE_CAPABILITIES: Record<Role, readonly Permission[]> = {
  MEMBER: MEMBER_CAPABILITIES,
  MANAGER: MANAGER_CAPABILITIES,
  HR: HR_CAPABILITIES,
  ADMIN: PERMISSIONS,
};

/**
 * What an HR who also manages a team may do for that team — a manager's
 * powers to change things. The changes reach only the team: `editUserIds` on
 * the request scope is what every edit route checks.
 */
const HR_TEAM_EDIT_CAPABILITIES = [
  'time.team.edit',
  'attendance.correct',
  'approvals.team.decide',
  'flags.team.review',
] as const satisfies readonly Permission[];

export function roleCapabilities(role: Role, opts: { managesTeam?: boolean } = {}): Permission[] {
  const base = [...ROLE_CAPABILITIES[role]];
  if (role === 'HR' && opts.managesTeam) {
    for (const p of HR_TEAM_EDIT_CAPABILITIES) if (!base.includes(p)) base.push(p);
  }
  return base;
}

export function hasPermission(roleOrCapabilities: Role | readonly Permission[], permission: Permission): boolean {
  const capabilities =
    typeof roleOrCapabilities === 'string'
      ? ROLE_CAPABILITIES[roleOrCapabilities]
      : roleOrCapabilities;
  return capabilities.includes(permission);
}

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
 * HR's one extra is the People tab — adds, edits, activates and suspends people
 * (never an admin or another HR, and never into either role). Everything else
 * is what her position would give anyone: her own reports, and — when she
 * manages a team — a manager's reads and edits for that team.
 */
const HR_CAPABILITIES = [
  ...MEMBER_CAPABILITIES,
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

export function roleCapabilities(role: Role, opts: { managesTeam?: boolean } = {}): Permission[] {
  const base = [...ROLE_CAPABILITIES[role]];
  // An HR who manages a team is that team's manager, with a manager's reads and edits.
  if (role === 'HR' && opts.managesTeam) {
    for (const p of MANAGER_CAPABILITIES) if (!base.includes(p)) base.push(p);
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

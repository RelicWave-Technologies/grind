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
  'payroll.manage',
  'overview.read',
  'tester-ops.manage',
  'api-tokens.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type DisplayRole = Role;

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
] as const satisfies readonly Permission[];

export const ROLE_CAPABILITIES: Record<Role, readonly Permission[]> = {
  MEMBER: MEMBER_CAPABILITIES,
  MANAGER: MANAGER_CAPABILITIES,
  ADMIN: PERMISSIONS,
};

export function roleCapabilities(role: Role): Permission[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasPermission(roleOrCapabilities: Role | readonly Permission[], permission: Permission): boolean {
  const capabilities =
    typeof roleOrCapabilities === 'string'
      ? ROLE_CAPABILITIES[roleOrCapabilities]
      : roleOrCapabilities;
  return capabilities.includes(permission);
}

export function isAdminRole(role: Role): boolean {
  return role === 'ADMIN';
}

export function isManagerOrAboveRole(role: Role): boolean {
  return role === 'ADMIN' || role === 'MANAGER';
}

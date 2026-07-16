import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, API_BASE } from './api';

/** Full-page URL that starts the Lark OAuth login (a top-level navigation, not
 *  a fetch — the API redirects through Lark and back, setting the session
 *  cookie). The sole entry point now that passwords are gone. */
export function larkLoginUrl(next?: string): string {
  const params = new URLSearchParams({ client: 'dashboard' });
  if (next) params.set('next', next);
  return `${API_BASE}/v1/auth/lark/start?${params.toString()}`;
}

export type Role = 'ADMIN' | 'MANAGER' | 'MEMBER';
export type ActivityRoleTitle = 'DEVELOPER' | 'DESIGNER' | 'SALES' | 'OTHER';
export type Permission =
  | 'profile.self.read'
  | 'reports.self.read'
  | 'reports.team.read'
  | 'reports.workspace.read'
  | 'time.self.edit'
  | 'time.team.edit'
  | 'people.read'
  | 'people.manage'
  | 'teams.read'
  | 'teams.manage'
  | 'team.settings.manage'
  | 'shifts.read'
  | 'shifts.manage'
  | 'policy.manage'
  | 'approvals.self.read'
  | 'approvals.team.decide'
  | 'approvals.workspace.decide'
  | 'flags.team.review'
  | 'flags.workspace.review'
  | 'payroll.manage'
  | 'overview.read'
  | 'tester-ops.manage'
  | 'api-tokens.manage';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  activityRoleTitle: ActivityRoleTitle;
  displayRole: Role;
  capabilities: Permission[];
  workspaceId: string;
  workspaceTimezone: string;
  teamId: string | null;
  managerId: string | null;
  managesTeamId?: string | null;
  managesTeamName?: string | null;
  provisioningStatus: 'PENDING' | 'ACTIVE';
  avatarUrl: string | null;
}

/**
 * Hits GET /v1/auth/me with the cookie. 401 means "not signed in" — we
 * return null and let the router route to /login. Any other failure
 * propagates so we don't silently treat infra errors as logged-out.
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me | null> => {
      try {
        const res = await api<{ user: Me }>('/v1/auth/me');
        return res.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api('/v1/auth/cookie-logout', { method: 'POST' });
    },
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.clear();
    },
  });
}

export function isAdmin(role: Role | undefined): boolean {
  return role === 'ADMIN';
}
export function isManagerOrAbove(role: Role | undefined): boolean {
  return role === 'ADMIN' || role === 'MANAGER';
}

export function hasCapability(me: Pick<Me, 'capabilities'> | null | undefined, permission: Permission): boolean {
  return !!me?.capabilities?.includes(permission);
}

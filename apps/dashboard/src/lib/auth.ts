import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type Role = 'ADMIN' | 'MANAGER' | 'MEMBER';
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
  | 'overview.read';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  displayRole: Role;
  capabilities: Permission[];
  workspaceId: string;
  teamId: string | null;
  managerId: string | null;
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

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      // /v1/auth/login sets the grind_at cookie as a side-effect; the
      // body still carries accessToken for the agent.
      return await api<{ user: Me }>('/v1/auth/login', { method: 'POST', json: input });
    },
    onSuccess: (data) => {
      qc.setQueryData(['me'], data.user);
    },
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

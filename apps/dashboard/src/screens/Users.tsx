import { useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { api } from '../lib/api';
import type { Role } from '../lib/auth';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  managerId: string | null;
  createdAt: string;
}

interface UsersResponse {
  users: AdminUser[];
  scope: 'self' | 'team' | 'workspace';
}

const SCOPE_LABEL: Record<UsersResponse['scope'], string> = {
  self: 'Just you',
  team: 'You + your team',
  workspace: 'Entire workspace',
};

const ROLE_RANK: Record<Role, number> = { OWNER: 0, ADMIN: 1, MANAGER: 2, MEMBER: 3 };

export function UsersScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const q = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<UsersResponse>('/v1/admin/users'),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">People</h1>
          <p className="secondary page-sub">
            Showing {q.data?.users.length ?? '…'} {q.data?.users.length === 1 ? 'person' : 'people'}{' '}
            ·{' '}
            <span className="scope-chip">
              {q.data ? SCOPE_LABEL[q.data.scope] : 'Loading scope…'}
            </span>
          </p>
        </div>
      </header>

      <section className="card" style={{ padding: 0 }}>
        {q.isLoading && <div className="empty">Loading…</div>}
        {q.isError && (
          <div className="empty empty-error">
            Couldn&apos;t load people: {(q.error as Error).message}
          </div>
        )}
        {q.data && (
          <table className="people-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {[...q.data.users]
                .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name))
                .map((u) => (
                  <tr key={u.id} className={u.id === me.id ? 'is-self' : undefined}>
                    <td>
                      <div className="person-name">{u.name}</div>
                      {u.id === me.id && <div className="callout secondary">(that&apos;s you)</div>}
                    </td>
                    <td className="secondary">{u.email}</td>
                    <td>
                      <span className={`role-chip role-${u.role.toLowerCase()}`}>{u.role}</span>
                    </td>
                    <td className="secondary">
                      {new Date(u.createdAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

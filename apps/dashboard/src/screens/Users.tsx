import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Pencil, Check, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { isAdmin, type Role } from '../lib/auth';
import type { Team, Shift } from '../lib/types';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  managerId: string | null;
  shiftId?: string | null;
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
const EDITABLE_ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'];

export function UsersScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const canEdit = isAdmin(me.role);
  const qc = useQueryClient();

  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<UsersResponse>('/v1/admin/users'),
  });
  // Only admins need the team + shift lists — pickers are hidden for everyone else.
  const teamsQ = useQuery({
    queryKey: ['admin', 'teams'],
    queryFn: () => api<{ teams: Team[] }>('/v1/admin/teams'),
    enabled: canEdit,
  });
  const shiftsQ = useQuery({
    queryKey: ['admin', 'shifts'],
    queryFn: () => api<{ shifts: Shift[] }>('/v1/admin/shifts'),
    enabled: canEdit,
  });

  const patch = useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Partial<{ name: string; role: Role; teamId: string | null; shiftId: string | null }>;
    }) =>
      api<AdminUser>(`/v1/admin/users/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const teamName = (id: string | null): string => {
    if (!id) return '—';
    return teamsQ.data?.teams.find((t) => t.id === id)?.name ?? id;
  };
  const shiftName = (id: string | null | undefined): string => {
    if (!id) return '—';
    return shiftsQ.data?.shifts.find((s) => s.id === id)?.name ?? id;
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">People</h1>
          <p className="secondary page-sub">
            Showing {usersQ.data?.users.length ?? '…'}{' '}
            {usersQ.data?.users.length === 1 ? 'person' : 'people'} ·{' '}
            <span className="scope-chip">
              {usersQ.data ? SCOPE_LABEL[usersQ.data.scope] : 'Loading scope…'}
            </span>
          </p>
        </div>
      </header>

      <section className="card" style={{ padding: 0 }}>
        {usersQ.isLoading && <div className="empty">Loading…</div>}
        {usersQ.isError && (
          <div className="empty empty-error">
            Couldn&apos;t load people: {(usersQ.error as Error).message}
          </div>
        )}
        {usersQ.data && (
          <table className="people-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Team</th>
                <th>Shift</th>
                <th>Joined</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {[...usersQ.data.users]
                .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name))
                .map((u) => (
                  <PersonRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === me.id}
                    canEdit={canEdit}
                    teams={teamsQ.data?.teams ?? []}
                    teamName={teamName(u.teamId)}
                    shifts={shiftsQ.data?.shifts ?? []}
                    shiftName={shiftName(u.shiftId)}
                    busy={patch.isPending && patch.variables?.id === u.id}
                    error={
                      patch.isError && patch.variables?.id === u.id
                        ? (patch.error as Error | ApiError).message
                        : null
                    }
                    onSave={(p) => patch.mutate({ id: u.id, patch: p })}
                  />
                ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

interface RowProps {
  user: AdminUser;
  isSelf: boolean;
  canEdit: boolean;
  teams: Team[];
  teamName: string;
  shifts: Shift[];
  shiftName: string;
  busy: boolean;
  error: string | null;
  onSave: (patch: Partial<{ name: string; role: Role; teamId: string | null; shiftId: string | null }>) => void;
}

function PersonRow({ user, isSelf, canEdit, teams, teamName, shifts, shiftName, busy, error, onSave }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [teamId, setTeamId] = useState<string>(user.teamId ?? '');
  const [shiftId, setShiftId] = useState<string>(user.shiftId ?? '');

  function save() {
    const next: Partial<{ name: string; role: Role; teamId: string | null; shiftId: string | null }> = {};
    if (name.trim() && name.trim() !== user.name) next.name = name.trim();
    if (role !== user.role) next.role = role;
    const nextTeam = teamId === '' ? null : teamId;
    if (nextTeam !== (user.teamId ?? null)) next.teamId = nextTeam;
    const nextShift = shiftId === '' ? null : shiftId;
    if (nextShift !== (user.shiftId ?? null)) next.shiftId = nextShift;
    if (Object.keys(next).length > 0) onSave(next);
    setEditing(false);
  }

  return (
    <tr className={isSelf ? 'is-self' : undefined}>
      <td>
        {editing ? (
          <input
            type="text"
            className="cell-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        ) : (
          <>
            <div className="person-name">{user.name}</div>
            {isSelf && <div className="callout secondary">(that&apos;s you)</div>}
          </>
        )}
        {error && <div className="approval-error people-error">{error}</div>}
      </td>
      <td className="secondary">{user.email}</td>
      <td>
        {editing ? (
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {EDITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span className={`role-chip role-${user.role.toLowerCase()}`}>{user.role}</span>
        )}
      </td>
      <td className="secondary">
        {editing ? (
          <select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">— no team —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          teamName
        )}
      </td>
      <td className="secondary">
        {editing ? (
          <select className="select" value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            <option value="">— no shift —</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          shiftName
        )}
      </td>
      <td className="secondary">
        {new Date(user.createdAt).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
      </td>
      {canEdit && (
        <td className="people-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="btn-icon"
                onClick={() => {
                  setEditing(false);
                  setName(user.name);
                  setRole(user.role);
                  setTeamId(user.teamId ?? '');
                  setShiftId(user.shiftId ?? '');
                }}
                disabled={busy}
                aria-label="Cancel"
              >
                <X size={14} strokeWidth={2} />
              </button>
              <button type="button" className="btn-icon btn-icon-primary" onClick={save} disabled={busy} aria-label="Save">
                <Check size={14} strokeWidth={2.2} />
              </button>
            </>
          ) : (
            <button type="button" className="btn-icon" onClick={() => setEditing(true)} aria-label="Edit person">
              <Pencil size={14} strokeWidth={2} />
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

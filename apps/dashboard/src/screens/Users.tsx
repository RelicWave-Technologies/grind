import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Pencil, Check, X, UserPlus, UserMinus, UserCheck, Loader2 } from 'lucide-react';
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
  deactivatedAt: string | null;
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
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [inviting, setInviting] = useState(false);

  const usersQ = useQuery({
    queryKey: ['admin', 'users', showDeactivated && canEdit],
    queryFn: () =>
      api<UsersResponse>(
        showDeactivated && canEdit
          ? '/v1/admin/users?includeDeactivated=true'
          : '/v1/admin/users',
      ),
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

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; deactivatedAt: string | null }>(
        `/v1/admin/users/${id}/deactivate`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; deactivatedAt: string | null }>(
        `/v1/admin/users/${id}/reactivate`,
        { method: 'POST' },
      ),
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
        {canEdit && (
          <div className="day-controls">
            <label className="btn-ghost stuck-toggle" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showDeactivated}
                onChange={(e) => setShowDeactivated(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Show deactivated
            </label>
            <button type="button" className="btn btn-prominent" onClick={() => setInviting(true)}>
              <UserPlus size={14} strokeWidth={2} /> Invite
            </button>
          </div>
        )}
      </header>

      {canEdit && inviting && (
        <InviteForm
          onClose={() => setInviting(false)}
          onCreated={() => {
            setInviting(false);
            qc.invalidateQueries({ queryKey: ['admin', 'users'] });
          }}
        />
      )}

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
                    busy={
                      (patch.isPending && patch.variables?.id === u.id) ||
                      (deactivate.isPending && deactivate.variables === u.id) ||
                      (reactivate.isPending && reactivate.variables === u.id)
                    }
                    error={
                      (patch.isError && patch.variables?.id === u.id
                        ? (patch.error as Error | ApiError).message
                        : null) ||
                      (deactivate.isError && deactivate.variables === u.id
                        ? (deactivate.error as Error | ApiError).message
                        : null) ||
                      (reactivate.isError && reactivate.variables === u.id
                        ? (reactivate.error as Error | ApiError).message
                        : null)
                    }
                    onSave={(p) => patch.mutate({ id: u.id, patch: p })}
                    onDeactivate={() => deactivate.mutate(u.id)}
                    onReactivate={() => reactivate.mutate(u.id)}
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
  onDeactivate: () => void;
  onReactivate: () => void;
}

function PersonRow({ user, isSelf, canEdit, teams, teamName, shifts, shiftName, busy, error, onSave, onDeactivate, onReactivate }: RowProps) {
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

  const isDeactivated = user.deactivatedAt !== null;
  const trClasses = [
    isSelf ? 'is-self' : '',
    isDeactivated ? 'is-deactivated' : '',
  ].filter(Boolean).join(' ');

  return (
    <tr className={trClasses || undefined}>
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
            <div className="person-name">
              {user.name}
              {isDeactivated && <span className="deactivated-pill">deactivated</span>}
            </div>
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
            <>
              {!isDeactivated && (
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setEditing(true)}
                  aria-label="Edit person"
                  disabled={busy}
                >
                  <Pencil size={14} strokeWidth={2} />
                </button>
              )}
              {isDeactivated ? (
                <button
                  type="button"
                  className="btn-icon btn-icon-primary"
                  onClick={onReactivate}
                  disabled={busy}
                  aria-label="Reactivate"
                  title="Reactivate this person"
                >
                  {busy ? <Loader2 size={14} className="spin" /> : <UserCheck size={14} strokeWidth={2} />}
                </button>
              ) : !isSelf ? (
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => {
                    if (window.confirm(`Deactivate ${user.name}? Their history stays for reports, but they can't log in until you reactivate.`)) {
                      onDeactivate();
                    }
                  }}
                  disabled={busy}
                  aria-label="Deactivate"
                  title="Deactivate this person"
                >
                  {busy ? <Loader2 size={14} className="spin" /> : <UserMinus size={14} strokeWidth={2} />}
                </button>
              ) : null}
            </>
          )}
        </td>
      )}
    </tr>
  );
}

// -----------------------------------------------------------------------------
// Invite form — inline card above the table. Calm, escape-cancels, error inline.

function InviteForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'OWNER'>>('MEMBER');
  const m = useMutation({
    mutationFn: (vars: { email: string; name: string; role: Role }) =>
      api<AdminUser>('/v1/admin/users', { method: 'POST', json: vars }),
    onSuccess: () => onCreated(),
  });

  const err =
    m.isError
      ? (m.error as ApiError).status === 409
        ? 'That email is already in use.'
        : (m.error as Error).message
      : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !name.trim()) return;
    m.mutate({ email: email.trim(), name: name.trim(), role });
  }

  return (
    <section
      className="card invite-form rise rise-1"
      style={{ padding: 'var(--sp-5) var(--sp-6)', marginBottom: 'var(--sp-3)' }}
    >
      <form onSubmit={submit} style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 220px' }}>
          <span className="small secondary">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            placeholder="pat@example.com"
            className="cell-input"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 180px' }}>
          <span className="small secondary">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            placeholder="Pat Khanna"
            className="cell-input"
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="small secondary">Role</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'OWNER'>)}>
            <option value="MEMBER">MEMBER</option>
            <option value="MANAGER">MANAGER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn btn-prominent" disabled={m.isPending || !email || !name}>
            {m.isPending ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} strokeWidth={2} />}
            {m.isPending ? 'Inviting…' : 'Invite'}
          </button>
        </div>
      </form>
      {err && <div className="approval-error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
      <p className="small tertiary" style={{ marginTop: 'var(--sp-3)' }}>
        A temporary password is generated server-side. Share it manually for v1 — magic-link onboarding is on the roadmap.
      </p>
    </section>
  );
}

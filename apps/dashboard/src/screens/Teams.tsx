import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Team } from '../lib/types';
import type { Role } from '../lib/auth';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
}

/**
 * Teams admin screen (ADMIN-only at the API layer; nav hides for others).
 *
 * Layout: a "Create team" composer at the top, then a list of teams in
 * the workspace with inline rename, manager reassignment, and a destructive
 * delete affordance (confirmed via two-step click — no JS confirm() popup
 * to keep the chrome consistent with the rest of the dashboard).
 *
 * Manager choice is "any user in the workspace" — we deliberately don't
 * filter to MANAGER role only. Admins routinely promote a strong member
 * to MANAGER as part of *creating* a team; refusing the assignment until
 * you've done the role change is busywork. The PATCH on user.role
 * elsewhere handles the role flip when needed.
 */
export function TeamsScreen() {
  const qc = useQueryClient();
  const teamsQ = useQuery({ queryKey: ['admin', 'teams'], queryFn: () => api<{ teams: Team[] }>('/v1/admin/teams') });
  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  const create = useMutation({
    mutationFn: (vars: { name: string; managerId: string | null }) =>
      api<Team>('/v1/admin/teams', { method: 'POST', json: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<{ name: string; managerId: string | null }> }) =>
      api<Team>(`/v1/admin/teams/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });

  const usersById = new Map((usersQ.data?.users ?? []).map((u) => [u.id, u]));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">Teams</h1>
          <p className="secondary page-sub">Create teams, assign managers, and reorg.</p>
        </div>
      </header>

      <NewTeamComposer
        users={usersQ.data?.users ?? []}
        busy={create.isPending}
        error={create.isError ? (create.error as Error | ApiError).message : null}
        onCreate={(vars) => create.mutate(vars)}
      />

      <section className="card teams-card" style={{ padding: 0, marginTop: 16 }}>
        {teamsQ.isLoading && <div className="empty">Loading…</div>}
        {teamsQ.isError && (
          <div className="empty empty-error">
            Couldn&apos;t load teams: {(teamsQ.error as Error).message}
          </div>
        )}
        {teamsQ.data && teamsQ.data.teams.length === 0 && (
          <div className="empty">No teams yet — create one above.</div>
        )}
        {teamsQ.data && teamsQ.data.teams.length > 0 && (
          <ul className="teams-list">
            {teamsQ.data.teams.map((t) => (
              <TeamRow
                key={t.id}
                team={t}
                users={usersQ.data?.users ?? []}
                manager={t.managerId ? usersById.get(t.managerId) ?? null : null}
                busy={(patch.isPending && patch.variables?.id === t.id) || (del.isPending && del.variables === t.id)}
                error={
                  (patch.isError && patch.variables?.id === t.id
                    ? (patch.error as Error | ApiError).message
                    : null) ||
                  (del.isError && del.variables === t.id ? (del.error as Error | ApiError).message : null)
                }
                onPatch={(p) => patch.mutate({ id: t.id, patch: p })}
                onDelete={() => del.mutate(t.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NewTeamComposer({
  users,
  busy,
  error,
  onCreate,
}: {
  users: AdminUser[];
  busy: boolean;
  error: string | null;
  onCreate: (vars: { name: string; managerId: string | null }) => void;
}) {
  const [name, setName] = useState('');
  const [managerId, setManagerId] = useState('');

  return (
    <form
      className="card composer-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate({ name: name.trim(), managerId: managerId || null });
        setName('');
        setManagerId('');
      }}
    >
      <div className="composer-row">
        <input
          type="text"
          className="composer-input"
          placeholder="Team name (e.g. Platform Squad)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        <select className="select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">— no manager —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} · {u.role.toLowerCase()}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
          <Plus size={14} strokeWidth={2.2} />
          <span>{busy ? 'Creating…' : 'Create team'}</span>
        </button>
      </div>
      {error && <div className="approval-error" style={{ marginTop: 10 }}>{error}</div>}
    </form>
  );
}

function TeamRow({
  team,
  users,
  manager,
  busy,
  error,
  onPatch,
  onDelete,
}: {
  team: Team;
  users: AdminUser[];
  manager: AdminUser | null;
  busy: boolean;
  error: string | null;
  onPatch: (patch: Partial<{ name: string; managerId: string | null }>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [managerId, setManagerId] = useState(team.managerId ?? '');
  const [pendingDelete, setPendingDelete] = useState(false);

  function save() {
    const next: Partial<{ name: string; managerId: string | null }> = {};
    if (name.trim() && name.trim() !== team.name) next.name = name.trim();
    const nextMgr = managerId === '' ? null : managerId;
    if (nextMgr !== (team.managerId ?? null)) next.managerId = nextMgr;
    if (Object.keys(next).length === 0) {
      setEditing(false);
      return;
    }
    onPatch(next);
    setEditing(false);
  }

  return (
    <li className="team-row">
      <div className="team-main">
        {editing ? (
          <input
            type="text"
            className="team-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
          />
        ) : (
          <div className="team-name">{team.name}</div>
        )}
        <div className="team-meta callout secondary">
          {team.memberCount} member{team.memberCount === 1 ? '' : 's'}
          {' · '}
          {editing ? (
            <select className="select team-mgr-select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">— no manager —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          ) : manager ? (
            <span>Manager: {manager.name}</span>
          ) : (
            <span className="tertiary">No manager</span>
          )}
        </div>
        {error && <div className="approval-error team-error">{error}</div>}
      </div>

      <div className="team-actions">
        {editing ? (
          <>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
              <X size={14} strokeWidth={2} />
              <span>Cancel</span>
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy}>
              <Check size={14} strokeWidth={2.2} />
              <span>Save</span>
            </button>
          </>
        ) : pendingDelete ? (
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDelete(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={onDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              <Pencil size={14} strokeWidth={2} />
              <span>Edit</span>
            </button>
            <button type="button" className="btn-ghost team-delete" onClick={() => setPendingDelete(true)}>
              <Trash2 size={14} strokeWidth={2} />
              <span>Delete</span>
            </button>
          </>
        )}
      </div>
    </li>
  );
}

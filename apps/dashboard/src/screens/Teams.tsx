import './teams.css';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X, UserRound, Users2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Team } from '../lib/types';
import type { Role } from '../lib/auth';
import {
  Page,
  PageHeader,
  Toolbar,
  Card,
  StatRow,
  Stat,
  Field,
  Input,
  Select,
  Button,
  IconButton,
  List,
  ListRow,
  Avatar,
  Banner,
  EmptyState,
  SkeletonTable,
} from '../ui';

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
 * Composed entirely from the shared "Quiet Datasheet" kit (../ui) per
 * src/ui/SYSTEM.md — PageHeader + Toolbar masthead, a flush StatRow for the
 * team count, a Card-hosted Field composer for create, and the directory as a
 * Card-flush List of rows. Inline rename, manager reassignment, and a two-step
 * delete (no JS confirm() popup) all live inside the row. Presentation only:
 * every query / mutation / handler and all loading / empty / error states are
 * unchanged from the prior implementation.
 *
 * Manager choice is "any user in the workspace" — we deliberately don't filter
 * to MANAGER role only. Admins routinely promote a strong member to MANAGER as
 * part of *creating* a team; refusing the assignment until you've done the role
 * change is busywork. The PATCH on user.role elsewhere handles the role flip.
 *
 * Page-unique CSS in teams.css is pure layout (grid/flex/gaps), prefixed `tms-`.
 */

export function TeamsScreen() {
  const qc = useQueryClient();
  const teamsQ = useQuery({ queryKey: ['admin', 'teams'], queryFn: () => api<{ teams: Team[] }>('/v1/admin/teams') });
  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  const [composing, setComposing] = useState(false);

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
  const teamCount = teamsQ.data?.teams.length ?? 0;

  const subtitle = teamsQ.data
    ? teamCount === 0
      ? 'No teams yet — create one to assign managers and shape the org.'
      : 'Group people, hand each team a manager, and reorg whenever the shape changes.'
    : 'Create teams, assign managers, and reorg.';

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace · Org structure"
        title="Teams"
        subtitle={subtitle}
        actions={
          <Toolbar>
            <Button
              variant="primary"
              icon={composing ? <X size={14} strokeWidth={2.2} /> : <Plus size={14} strokeWidth={2.2} />}
              onClick={() => setComposing((v) => !v)}
              aria-expanded={composing}
            >
              {composing ? 'Close' : 'New team'}
            </Button>
          </Toolbar>
        }
      />

      {teamsQ.data && (
        <Card variant="flush" className="tms-rise">
          <StatRow>
            <Stat label="Teams" value={teamCount} hint={teamCount === 1 ? 'team in the org' : 'teams in the org'} />
          </StatRow>
        </Card>
      )}

      {composing && (
        <NewTeamComposer
          users={usersQ.data?.users ?? []}
          busy={create.isPending}
          error={create.isError ? (create.error as Error | ApiError).message : null}
          onCreate={(vars) =>
            create.mutate(vars, {
              onSuccess: () => setComposing(false),
            })
          }
          onCancel={() => setComposing(false)}
        />
      )}

      <Card title="Directory" variant="flush" className="tms-rise tms-rise-1">
        {teamsQ.isLoading ? (
          <div className="tms-pad">
            <SkeletonTable rows={4} />
          </div>
        ) : teamsQ.isError ? (
          <div className="tms-pad">
            <Banner status="danger">Couldn&apos;t load teams: {(teamsQ.error as Error).message}</Banner>
          </div>
        ) : teamsQ.data && teamsQ.data.teams.length === 0 ? (
          <EmptyState
            icon={<Users2 size={22} strokeWidth={1.8} />}
            title="No teams yet"
            description="Create your first team with “New team” to start assigning managers and grouping people."
          />
        ) : (
          <List>
            {(teamsQ.data?.teams ?? []).map((t) => (
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
          </List>
        )}
      </Card>
    </Page>
  );
}

function NewTeamComposer({
  users,
  busy,
  error,
  onCreate,
  onCancel,
}: {
  users: AdminUser[];
  busy: boolean;
  error: string | null;
  onCreate: (vars: { name: string; managerId: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [managerId, setManagerId] = useState('');

  return (
    <Card title="New team" className="tms-rise tms-rise-1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onCreate({ name: name.trim(), managerId: managerId || null });
          setName('');
          setManagerId('');
        }}
      >
        <div className="tms-form">
          <Field label="Team name" className="tms-form__name">
            <Input
              type="text"
              placeholder="e.g. Platform Squad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </Field>
          <Field label="Manager" className="tms-form__mgr">
            <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">— no manager —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.role.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <div className="tms-form__actions">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={<Plus size={14} strokeWidth={2.2} />}
              loading={busy}
              disabled={!name.trim()}
            >
              {busy ? 'Creating…' : 'Create team'}
            </Button>
          </div>
        </div>
        {error && (
          <div className="tms-form__err">
            <Banner status="danger">{error}</Banner>
          </div>
        )}
      </form>
    </Card>
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

  function cancelEdit() {
    setEditing(false);
    setName(team.name);
    setManagerId(team.managerId ?? '');
  }

  const memberMeta = `${team.memberCount} ${team.memberCount === 1 ? 'person' : 'people'}`;

  return (
    <div className="tms-row">
      <ListRow
        leading={<Avatar name={team.name} size={32} />}
        title={team.name}
        subtitle={
          manager ? (
            <span className="tms-mgr">
              <UserRound size={12} strokeWidth={2} aria-hidden /> {manager.name}
            </span>
          ) : (
            'No manager'
          )
        }
        meta={memberMeta}
        trailing={
          editing || pendingDelete ? undefined : (
            <>
              <IconButton
                icon={<Pencil size={14} strokeWidth={1.9} />}
                aria-label="Edit team"
                onClick={() => setEditing(true)}
                disabled={busy}
              />
              <IconButton
                icon={<Trash2 size={14} strokeWidth={1.9} />}
                aria-label="Delete team"
                variant="danger"
                onClick={() => setPendingDelete(true)}
                disabled={busy}
              />
            </>
          )
        }
      />

      {editing && (
        <div className="tms-edit">
          <div className="tms-form">
            <Field label="Team name" className="tms-form__name">
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
                aria-label="Team name"
              />
            </Field>
            <Field label="Manager" className="tms-form__mgr">
              <Select value={managerId} onChange={(e) => setManagerId(e.target.value)} aria-label="Manager">
                <option value="">— no manager —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="tms-form__actions">
              <Button variant="ghost" onClick={cancelEdit} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<Check size={14} strokeWidth={2.2} />}
                onClick={save}
                loading={busy}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && !editing && (
        <div className="tms-confirm">
          <Banner
            status="danger"
            action={
              <div className="tms-confirm__actions">
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={onDelete} loading={busy}>
                  Delete team
                </Button>
              </div>
            }
          >
            Delete <strong>{team.name}</strong>? This can&apos;t be undone.
          </Banner>
        </div>
      )}

      {error && (
        <div className="tms-row__err">
          <Banner status="danger">{error}</Banner>
        </div>
      )}
    </div>
  );
}

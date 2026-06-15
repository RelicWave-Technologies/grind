import './teams.css';
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  Mail,
  Minus,
  Pencil,
  Plus,
  Trash2,
  UserRound,
  Users2,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { addDays, fmtDurationMs, todayKey } from '../lib/format';
import type { Team } from '../lib/types';
import type { Role } from '../lib/auth';
import type { MemberReportTopApp, TeamReportMember, TeamReportsResponse } from '@grind/types/reports';
import { AppIcon } from '../components/AppIcon';
import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  List,
  Page,
  PageHeader,
  Select,
  SkeletonTable,
  Tag,
  Toolbar,
} from '../ui';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  teamId: string | null;
}

type TeamPatch = Partial<{ name: string; managerId: string }>;
type UserPatch = Partial<{ teamId: string | null }>;

export function TeamsScreen() {
  const qc = useQueryClient();
  const teamsQ = useQuery({ queryKey: ['admin', 'teams'], queryFn: () => api<{ teams: Team[] }>('/v1/admin/teams') });
  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = todayKey();
  const performanceFrom = addDays(today, -6);
  const performanceTo = today;

  const teams = teamsQ.data?.teams ?? [];
  const users = usersQ.data?.users ?? [];
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const teamsById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const teamByManagerId = useMemo(() => {
    const map = new Map<string, Team>();
    for (const team of teams) {
      if (team.managerId) map.set(team.managerId, team);
    }
    return map;
  }, [teams]);
  const membersByTeam = useMemo(() => {
    const map = new Map<string, AdminUser[]>();
    for (const team of teams) map.set(team.id, []);
    for (const user of users) {
      if (!user.teamId) continue;
      map.get(user.teamId)?.push(user);
    }
    return map;
  }, [teams, users]);

  const teamCount = teams.length;
  const totalMembers = teams.reduce((sum, team) => sum + team.memberCount, 0);
  const managedTeams = teams.filter((team) => team.managerId).length;
  const selectedTeam = selectedTeamId ? teams.find((team) => team.id === selectedTeamId) ?? null : null;
  const selectedMemberIds = useMemo(() => {
    if (!selectedTeam) return new Set<string>();
    return new Set((membersByTeam.get(selectedTeam.id) ?? []).map((member) => member.id));
  }, [membersByTeam, selectedTeam]);

  const performanceQ = useQuery({
    queryKey: ['reports', 'team', 'teams-drawer', performanceFrom, performanceTo, tz],
    enabled: Boolean(selectedTeamId),
    queryFn: () => {
      const params = new URLSearchParams({ from: performanceFrom, to: performanceTo, tz });
      return api<TeamReportsResponse>(`/v1/reports/team?${params.toString()}`);
    },
  });
  const selectedPerformanceMembers = useMemo(() => {
    if (!performanceQ.data || selectedMemberIds.size === 0) return [];
    return performanceQ.data.members.filter((member) => selectedMemberIds.has(member.user.id));
  }, [performanceQ.data, selectedMemberIds]);

  const create = useMutation({
    mutationFn: (vars: { name: string; managerId: string }) =>
      api<Team>('/v1/admin/teams', { method: 'POST', json: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; patch: TeamPatch }) =>
      api<Team>(`/v1/admin/teams/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
  });
  const patchUser = useMutation({
    mutationFn: (vars: { id: string; patch: UserPatch }) =>
      api(`/v1/admin/users/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['admin', 'teams'] });
      qc.invalidateQueries({ queryKey: ['reports', 'team'] });
    },
  });

  const subtitle = teamsQ.data
    ? teamCount === 0
      ? 'Create a team with a manager before assigning members.'
      : 'Group people, assign a manager, and keep reporting lines readable.'
    : 'Create teams, assign managers, and keep the org structure tidy.';

  return (
    <Page className="tms-page">
      <PageHeader
        eyebrow="Workspace · Org structure"
        title="Teams"
        subtitle={subtitle}
        actions={
          <Toolbar>
            <Button
              variant="primary"
              icon={<Plus size={14} strokeWidth={2.2} />}
              onClick={() => setCreateOpen(true)}
            >
              New team
            </Button>
          </Toolbar>
        }
      />

      {teamsQ.data && (
        <section className="tms-summary tms-rise" aria-label="Team overview">
          <SummaryItem label="Teams" value={teamCount} hint={teamCount === 1 ? 'team in the org' : 'teams in the org'} />
          <SummaryItem label="Managed" value={`${managedTeams}/${teamCount}`} hint="teams with a manager" />
          <SummaryItem label="People" value={totalMembers} hint={totalMembers === 1 ? 'assigned person' : 'assigned people'} />
        </section>
      )}

      <Card
        title="Directory"
        action={<Tag mono>{teamCount}</Tag>}
        variant="flush"
        className="tms-directory tms-rise tms-rise-1"
      >
        {teamsQ.isLoading ? (
          <div className="tms-pad">
            <SkeletonTable rows={4} />
          </div>
        ) : teamsQ.isError ? (
          <div className="tms-pad">
            <Banner status="danger">Couldn&apos;t load teams: {(teamsQ.error as Error).message}</Banner>
          </div>
        ) : teams.length === 0 ? (
          <EmptyState
            icon={<Users2 size={22} strokeWidth={1.8} />}
            title="No teams yet"
            description="Create your first team with a manager to start grouping members."
          />
        ) : (
          <List className="tms-list">
            {teams.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                users={users}
                teamByManagerId={teamByManagerId}
                manager={team.managerId ? usersById.get(team.managerId) ?? null : null}
                busy={(patch.isPending && patch.variables?.id === team.id) || (del.isPending && del.variables === team.id)}
                error={
                  (patch.isError && patch.variables?.id === team.id
                    ? (patch.error as Error | ApiError).message
                    : null) ||
                  (del.isError && del.variables === team.id ? (del.error as Error | ApiError).message : null)
                }
                onOpen={() => setSelectedTeamId(team.id)}
                onPatch={(nextPatch) => patch.mutate({ id: team.id, patch: nextPatch })}
                onDelete={() =>
                  del.mutate(team.id, {
                    onSuccess: () => {
                      if (selectedTeamId === team.id) setSelectedTeamId(null);
                    },
                  })
                }
              />
            ))}
          </List>
        )}
      </Card>

      {createOpen && (
        <NewTeamModal
          users={users}
          teamByManagerId={teamByManagerId}
          busy={create.isPending}
          error={create.isError ? (create.error as Error | ApiError).message : null}
          onCreate={(vars) =>
            create.mutate(vars, {
              onSuccess: () => setCreateOpen(false),
            })
          }
          onClose={() => setCreateOpen(false)}
        />
      )}

      {selectedTeam && (
        <TeamDrawer
          team={selectedTeam}
          manager={selectedTeam.managerId ? usersById.get(selectedTeam.managerId) ?? null : null}
          members={membersByTeam.get(selectedTeam.id) ?? []}
          users={users}
          teamByManagerId={teamByManagerId}
          teamsById={teamsById}
          performanceMembers={selectedPerformanceMembers}
          performanceFrom={performanceFrom}
          performanceTo={performanceTo}
          performanceLoading={performanceQ.isLoading}
          performanceError={performanceQ.isError ? (performanceQ.error as Error).message : null}
          changingManager={patch.isPending && patch.variables?.id === selectedTeam.id}
          memberMutationUserId={patchUser.isPending ? patchUser.variables?.id ?? null : null}
          memberMutationError={patchUser.isError ? (patchUser.error as Error | ApiError).message : null}
          onChangeManager={(managerId) => patch.mutate({ id: selectedTeam.id, patch: { managerId } })}
          onAddMember={(userId) => patchUser.mutate({ id: userId, patch: { teamId: selectedTeam.id } })}
          onRemoveMember={(userId) => patchUser.mutate({ id: userId, patch: { teamId: null } })}
          onClose={() => setSelectedTeamId(null)}
        />
      )}
    </Page>
  );
}

function SummaryItem({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="tms-summary__item">
      <span className="tms-summary__label ui-t-eyebrow">{label}</span>
      <strong className="tms-summary__value ui-t-num">{value}</strong>
      <span className="tms-summary__hint ui-t-small">{hint}</span>
    </div>
  );
}

function NewTeamModal({
  users,
  teamByManagerId,
  busy,
  error,
  onCreate,
  onClose,
}: {
  users: AdminUser[];
  teamByManagerId: Map<string, Team>;
  busy: boolean;
  error: string | null;
  onCreate: (vars: { name: string; managerId: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [managerId, setManagerId] = useState('');
  const managerOptions = availableManagerOptions(users, teamByManagerId);
  const canSubmit = Boolean(name.trim() && managerId);

  return createPortal(
    <div className="tms-layer" role="presentation" onMouseDown={onClose}>
      <form
        className="tms-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tms-create-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onCreate({ name: name.trim(), managerId });
        }}
      >
        <div className="tms-layer-head">
          <div>
            <span className="ui-t-eyebrow">New team</span>
            <h2 id="tms-create-title" className="tms-layer-title ui-t-title">
              Create team
            </h2>
          </div>
          <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close new team dialog" onClick={onClose} />
        </div>

        <div className="tms-modal-body">
          <Field label="Team name">
            <Input
              type="text"
              placeholder="e.g. Platform Squad"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoFocus
            />
          </Field>
          <Field label="Manager">
            <Select
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
              disabled={managerOptions.length === 0}
              required
            >
              <option value="" disabled>
                {managerOptions.length === 0 ? 'No available managers' : 'Select a manager'}
              </option>
              {managerOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {roleLabel(user.role)}
                </option>
              ))}
            </Select>
          </Field>
          <Banner status="info">Every team needs a manager, and one person can manage only one team.</Banner>
          {error && <Banner status="danger">{error}</Banner>}
        </div>

        <div className="tms-layer-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={14} strokeWidth={2.2} />}
            loading={busy}
            disabled={!canSubmit}
          >
            Create team
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function TeamRow({
  team,
  users,
  teamByManagerId,
  manager,
  busy,
  error,
  onOpen,
  onPatch,
  onDelete,
}: {
  team: Team;
  users: AdminUser[];
  teamByManagerId: Map<string, Team>;
  manager: AdminUser | null;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onPatch: (patch: TeamPatch) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [managerId, setManagerId] = useState(team.managerId ?? '');
  const [pendingDelete, setPendingDelete] = useState(false);
  const managerOptions = availableManagerOptions(users, teamByManagerId, team.id);

  function save() {
    if (!name.trim() || !managerId) return;
    const next: TeamPatch = {};
    if (name.trim() !== team.name) next.name = name.trim();
    if (managerId !== (team.managerId ?? '')) next.managerId = managerId;
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

  function stopRowClick(event: MouseEvent) {
    event.stopPropagation();
  }

  const memberMeta = `${team.memberCount} ${team.memberCount === 1 ? 'person' : 'people'}`;

  return (
    <div className="tms-row">
      <div className="tms-team-row">
        <button className="tms-team-hit" type="button" onClick={onOpen} disabled={editing || pendingDelete}>
          <span className="tms-team-leading">
            <Avatar name={team.name} size={40} />
          </span>
          <span className="tms-team-main">
            <span className="ui-t-strong">{team.name}</span>
            {manager ? (
              <span className="tms-row-sub ui-t-small">
                <UserRound size={13} strokeWidth={2} aria-hidden />
                <span>{manager.name}</span>
              </span>
            ) : (
              <span className="tms-row-sub tms-row-sub--warn ui-t-small">
                <UserRound size={13} strokeWidth={2} aria-hidden />
                Manager required
              </span>
            )}
          </span>
          <span className="tms-row-count ui-mono">{memberMeta}</span>
          <ChevronRight className="tms-chevron" size={18} strokeWidth={1.8} aria-hidden />
        </button>

        {!editing && !pendingDelete && (
          <div className="tms-row-actions">
            <IconButton
              icon={<Pencil size={14} strokeWidth={1.9} />}
              aria-label={`Edit ${team.name}`}
              onClick={() => setEditing(true)}
              disabled={busy}
            />
            <IconButton
              icon={<Trash2 size={14} strokeWidth={1.9} />}
              aria-label={`Delete ${team.name}`}
              variant="danger"
              onClick={() => setPendingDelete(true)}
              disabled={busy}
            />
          </div>
        )}
      </div>

      {editing && (
        <div className="tms-edit" onClick={stopRowClick}>
          <div className="tms-edit-grid">
            <Field label="Team name">
              <Input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus
                aria-label="Team name"
              />
            </Field>
            <Field label="Manager">
              <Select value={managerId} onChange={(event) => setManagerId(event.target.value)} aria-label="Manager" required>
                <option value="" disabled>
                  Select a manager
                </option>
                {managerOptions.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="tms-edit-actions">
              <IconButton
                icon={<X size={15} strokeWidth={2} />}
                aria-label="Cancel edit"
                onClick={cancelEdit}
                disabled={busy}
              />
              <IconButton
                icon={<Check size={15} strokeWidth={2.2} />}
                aria-label="Save team"
                variant="primary"
                onClick={save}
                loading={busy}
                disabled={!name.trim() || !managerId}
              />
            </div>
          </div>
        </div>
      )}

      {pendingDelete && !editing && (
        <div className="tms-confirm" onClick={stopRowClick}>
          <Banner
            status="danger"
            action={
              <div className="tms-confirm-actions">
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={onDelete} loading={busy}>
                  Delete team
                </Button>
              </div>
            }
          >
            Delete <strong>{team.name}</strong>? Members keep their accounts but lose this team assignment.
          </Banner>
        </div>
      )}

      {error && (
        <div className="tms-row-err">
          <Banner status="danger">{error}</Banner>
        </div>
      )}
    </div>
  );
}

function TeamDrawer({
  team,
  manager,
  members,
  users,
  teamByManagerId,
  teamsById,
  performanceMembers,
  performanceFrom,
  performanceTo,
  performanceLoading,
  performanceError,
  changingManager,
  memberMutationUserId,
  memberMutationError,
  onChangeManager,
  onAddMember,
  onRemoveMember,
  onClose,
}: {
  team: Team;
  manager: AdminUser | null;
  members: AdminUser[];
  users: AdminUser[];
  teamByManagerId: Map<string, Team>;
  teamsById: Map<string, Team>;
  performanceMembers: TeamReportMember[];
  performanceFrom: string;
  performanceTo: string;
  performanceLoading: boolean;
  performanceError: string | null;
  changingManager: boolean;
  memberMutationUserId: string | null;
  memberMutationError: string | null;
  onChangeManager: (managerId: string) => void;
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
  onClose: () => void;
}) {
  const [editingManager, setEditingManager] = useState(false);
  const [nextManagerId, setNextManagerId] = useState(team.managerId ?? '');
  const [addingMember, setAddingMember] = useState(false);
  const availableUsers = users.filter((user) => user.teamId !== team.id);
  const managerOptions = availableManagerOptions(users, teamByManagerId, team.id);

  function cancelManagerEdit() {
    setEditingManager(false);
    setNextManagerId(team.managerId ?? '');
  }

  function saveManager() {
    if (!nextManagerId || nextManagerId === team.managerId) {
      setEditingManager(false);
      return;
    }
    onChangeManager(nextManagerId);
    setEditingManager(false);
  }

  return createPortal(
    <div className="tms-drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        className="tms-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tms-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="tms-layer-head">
          <div className="tms-drawer-id">
            <Avatar name={team.name} size={40} />
            <div>
              <span className="ui-t-eyebrow">Team</span>
              <h2 id="tms-drawer-title" className="tms-layer-title ui-t-title">
                {team.name}
              </h2>
            </div>
          </div>
          <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close team details" onClick={onClose} />
        </div>

        <div className="tms-drawer-body">
          <section className="tms-facts" aria-label="Team facts">
            <DrawerFact icon={<Users2 size={17} />} label="Members" value={members.length} hint={memberCountLabel(members.length)} />
            <DrawerFact icon={<UserRound size={17} />} label="Manager" value={manager?.name ?? 'Missing'} hint={manager?.email ?? 'Assign one'} />
            <DrawerFact icon={<CalendarDays size={17} />} label="Created" value={formatDate(team.createdAt)} hint="Org structure" />
          </section>

          <TeamPerformance
            members={performanceMembers}
            memberCount={members.length}
            from={performanceFrom}
            to={performanceTo}
            loading={performanceLoading}
            error={performanceError}
          />

          <section className="tms-section">
            <div className="tms-section-head">
              <h3 className="ui-t-h3">Manager</h3>
              {editingManager ? (
                <div className="tms-inline-actions">
                  <IconButton
                    size="sm"
                    icon={<X size={14} strokeWidth={2} />}
                    aria-label="Cancel manager change"
                    onClick={cancelManagerEdit}
                    disabled={changingManager}
                  />
                  <IconButton
                    size="sm"
                    icon={<Check size={14} strokeWidth={2.2} />}
                    aria-label="Save manager"
                    variant="primary"
                    onClick={saveManager}
                    loading={changingManager}
                    disabled={!nextManagerId}
                  />
                </div>
              ) : (
                <Button size="sm" variant="secondary" icon={<Pencil size={13} strokeWidth={1.8} />} onClick={() => setEditingManager(true)}>
                  Change
                </Button>
              )}
            </div>
            {editingManager ? (
              <div className="tms-manager-edit">
                <Field label="Manager">
                  <Select value={nextManagerId} onChange={(event) => setNextManagerId(event.target.value)} required>
                    <option value="" disabled>
                      Select a manager
                    </option>
                    {managerOptions.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} · {roleLabel(user.role)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : manager ? (
              <PersonLine user={manager} icon={<UserRound size={17} strokeWidth={1.8} />} />
            ) : (
              <div className="tms-empty-line ui-t-small">This team needs a manager before it should be used for reporting.</div>
            )}
          </section>

          <section className="tms-section">
            <div className="tms-section-head">
              <h3 className="ui-t-h3">Members</h3>
              <Button size="sm" variant="secondary" icon={<Plus size={13} strokeWidth={2} />} onClick={() => setAddingMember(true)}>
                Add
              </Button>
            </div>
            {memberMutationError && <Banner status="danger">{memberMutationError}</Banner>}
            {members.length === 0 ? (
              <div className="tms-empty-line ui-t-small">No members are assigned to this team yet.</div>
            ) : (
              <div className="tms-person-list">
                {members.map((member) => (
                  <PersonLine
                    key={member.id}
                    user={member}
                    action={
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Minus size={13} strokeWidth={2} />}
                        onClick={() => onRemoveMember(member.id)}
                        loading={memberMutationUserId === member.id}
                      >
                        Remove
                      </Button>
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <section className="tms-section">
            <div className="tms-section-head">
              <h3 className="ui-t-h3">Workspace scope</h3>
              <Tag status="neutral" mono>
                Admin
              </Tag>
            </div>
            <div className="tms-scope-line ui-t-small">
              <Building2 size={17} strokeWidth={1.8} aria-hidden />
              <span>Admins can rename the team, reassign its manager, or remove it from the directory.</span>
            </div>
          </section>
        </div>
      </aside>
      {addingMember && (
        <AddMemberModal
          team={team}
          users={availableUsers}
          teamsById={teamsById}
          busyUserId={memberMutationUserId}
          error={memberMutationError}
          onAdd={(userId) => {
            onAddMember(userId);
            setAddingMember(false);
          }}
          onClose={() => setAddingMember(false)}
        />
      )}
    </div>,
    document.body,
  );
}

function TeamPerformance({
  members,
  memberCount,
  from,
  to,
  loading,
  error,
}: {
  members: TeamReportMember[];
  memberCount: number;
  from: string;
  to: string;
  loading: boolean;
  error: string | null;
}) {
  const performance = summarizePerformance(members);

  return (
    <section className="tms-section tms-performance">
      <div className="tms-section-head">
        <div>
          <h3 className="ui-t-h3">Team performance</h3>
          <p className="ui-t-small">{formatShortRange(from, to)}</p>
        </div>
        <Tag mono>{memberCount}</Tag>
      </div>
      {loading ? (
        <div className="tms-empty-line ui-t-small">Loading recent performance…</div>
      ) : error ? (
        <Banner status="danger">Couldn&apos;t load performance: {error}</Banner>
      ) : (
        <>
          <div className="tms-performance-grid">
            <PerformanceMetric label="Worked" value={fmtDurationMs(performance.workedMs)} hint={`${performance.activeMembers}/${memberCount} active`} />
            <PerformanceMetric label="Approved" value={fmtDurationMs(performance.manualMs)} hint="manual time" />
            <PerformanceMetric label="Activity" value={percentLabel(performance.activityPercent)} hint="average" />
            <PerformanceMetric label="Pending" value={performance.pendingApprovals} hint="approvals" />
          </div>
          <div className="tms-top-app">
            <span className="ui-t-eyebrow">Top app</span>
            {performance.topApp ? (
              <span className="tms-top-app__body">
                <AppIcon name={performance.topApp.app} iconUrl={performance.topApp.iconUrl} />
                <span>
                  <strong className="ui-t-strong">{performance.topApp.app}</strong>
                  <span className="ui-t-small">{fmtDurationMs(performance.topApp.minutes * 60_000)}</span>
                </span>
              </span>
            ) : (
              <span className="ui-t-small ui-ink-3">No app activity yet</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PerformanceMetric({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return (
    <div className="tms-performance-metric">
      <span className="ui-t-eyebrow">{label}</span>
      <strong className="ui-t-strong">{value}</strong>
      <span className="ui-t-small">{hint}</span>
    </div>
  );
}

function AddMemberModal({
  team,
  users,
  teamsById,
  busyUserId,
  error,
  onAdd,
  onClose,
}: {
  team: Team;
  users: AdminUser[];
  teamsById: Map<string, Team>;
  busyUserId: string | null;
  error: string | null;
  onAdd: (userId: string) => void;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState('');
  const canSubmit = Boolean(userId);
  return (
    <div className="tms-nested-layer" role="presentation" onMouseDown={onClose}>
      <form
        className="tms-modal tms-modal--small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tms-add-member-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onAdd(userId);
        }}
      >
        <div className="tms-layer-head">
          <div>
            <span className="ui-t-eyebrow">Add member</span>
            <h2 id="tms-add-member-title" className="tms-layer-title ui-t-title">
              {team.name}
            </h2>
          </div>
          <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close add member dialog" onClick={onClose} />
        </div>
        <div className="tms-modal-body">
          <Field label="Person">
            <Select value={userId} onChange={(event) => setUserId(event.target.value)} disabled={users.length === 0} required>
              <option value="" disabled>
                {users.length === 0 ? 'No people available' : 'Select a person'}
              </option>
              {users.map((user) => {
                const currentTeam = user.teamId ? teamsById.get(user.teamId)?.name ?? 'Another team' : 'Unassigned';
                return (
                  <option key={user.id} value={user.id}>
                    {user.name} · {roleLabel(user.role)} · {currentTeam}
                  </option>
                );
              })}
            </Select>
          </Field>
          <Banner status="info">Adding a person moves them into this team.</Banner>
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <div className="tms-layer-actions">
          <Button variant="ghost" onClick={onClose} disabled={Boolean(busyUserId)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={14} strokeWidth={2.2} />}
            loading={Boolean(busyUserId)}
            disabled={!canSubmit}
          >
            Add member
          </Button>
        </div>
      </form>
    </div>
  );
}

function DrawerFact({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint: string }) {
  return (
    <div className="tms-fact">
      <span className="tms-fact__icon">{icon}</span>
      <span className="ui-t-eyebrow">{label}</span>
      <strong className="ui-t-strong">{value}</strong>
      <span className="ui-t-small">{hint}</span>
    </div>
  );
}

function PersonLine({ user, icon, action }: { user: AdminUser; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="tms-person">
      <span className="tms-person__lead">{icon ?? <Avatar name={user.name} src={user.avatarUrl ?? undefined} size={32} />}</span>
      <div className="tms-person__body">
        <strong className="ui-t-strong">{user.name}</strong>
        <span className="ui-t-small">
          <Mail size={13} strokeWidth={1.8} aria-hidden />
          {user.email}
        </span>
      </div>
      <span className="tms-person__action">{action ?? <Tag mono>{roleLabel(user.role)}</Tag>}</span>
    </div>
  );
}

function summarizePerformance(members: TeamReportMember[]) {
  let workedMs = 0;
  let manualMs = 0;
  let pendingApprovals = 0;
  let activeMembers = 0;
  let activitySum = 0;
  let activityCount = 0;
  const apps = new Map<string, MemberReportTopApp>();

  for (const member of members) {
    workedMs += member.workedMs;
    manualMs += member.manualMs;
    pendingApprovals += member.approvals.pending;
    if (member.workedMs > 0) activeMembers += 1;
    if (member.activityPercent !== null) {
      activitySum += member.activityPercent;
      activityCount += 1;
    }
    for (const app of member.topApps) {
      const key = `${app.app}\u0000${app.appBundle ?? ''}`;
      const previous = apps.get(key);
      if (previous) {
        apps.set(key, { ...previous, minutes: previous.minutes + app.minutes });
      } else {
        apps.set(key, { ...app });
      }
    }
  }

  const topApp = [...apps.values()].sort((a, b) => b.minutes - a.minutes)[0] ?? null;
  return {
    workedMs,
    manualMs,
    pendingApprovals,
    activeMembers,
    activityPercent: activityCount > 0 ? Math.round(activitySum / activityCount) : null,
    topApp,
  };
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

function formatShortRange(from: string, to: string) {
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return `${fmt.format(parseDateKey(from))} - ${fmt.format(parseDateKey(to))}`;
}

function parseDateKey(key: string) {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year!, month! - 1, day!);
}

function percentLabel(value: number | null) {
  return value === null ? '—' : `${value}%`;
}

function availableManagerOptions(users: AdminUser[], teamByManagerId: Map<string, Team>, currentTeamId?: string) {
  return users.filter((user) => {
    const managedTeam = teamByManagerId.get(user.id);
    return !managedTeam || managedTeam.id === currentTeamId;
  });
}

function roleLabel(role: Role) {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

function memberCountLabel(count: number) {
  return count === 1 ? 'assigned person' : 'assigned people';
}

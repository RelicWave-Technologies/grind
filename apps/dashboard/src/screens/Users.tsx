import './users.css';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Pencil, Check, X, UserPlus, UserMinus, UserCheck, Users as UsersIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { isAdmin, type Role } from '../lib/auth';
import type { Team, Shift } from '../lib/types';
import {
  Page,
  PageHeader,
  Toolbar,
  Segmented,
  Card,
  Stat,
  StatRow,
  Table,
  THead,
  Tbody,
  Th,
  Tr,
  Td,
  Identity,
  Avatar,
  Tag,
  Button,
  IconButton,
  Field,
  Input,
  Select,
  Banner,
  EmptyState,
  SkeletonTable,
  type Status,
} from '../ui';

/**
 * /users — people management, composed entirely from the shared "Quiet
 * Datasheet" kit so it reads as one product with every other page. A
 * PageHeader (scope eyebrow · People · count) carries the Active/All status
 * Segmented and the primary Invite action; a flush StatRow summarises active vs
 * deactivated; the roster is the kit Table (Identity first-cell, taxonomy Tags
 * for role + status, mono Joined, IconButton actions, self = accent rail).
 * Inline edit swaps cells for kit Field controls; Invite is a calm Card.
 *
 * Behaviour is IDENTICAL to before — same queries, mutations, inline edit,
 * invite + (de/re)activate ADMIN actions, show-deactivated toggle, and states.
 */

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  teamId: string | null;
  managerId: string | null;
  managesTeamId: string | null;
  managesTeamName: string | null;
  shiftId?: string | null;
  deactivatedAt: string | null;
  provisioningStatus?: 'PENDING' | 'ACTIVE';
  createdAt: string;
  agentLastSeenAt: string | null;
  agentState: 'IDLE' | 'RUNNING' | 'PAUSED_IDLE' | 'OFFLINE' | null;
  agentVersion: string | null;
  agentPlatform: string | null;
  agentScreenPermissionStatus: string | null;
  agentScreenCaptureHealth: string | null;
  agentScreenPermissionState: string | null;
  agentAccessibilityTrusted: boolean | null;
  agentAccessibilityReady: boolean | null;
  agentAccessibilityRecording: boolean | null;
  agentAccessibilityCapturing: boolean | null;
  agentAccessibilityHookRunning: boolean | null;
  agentPermissionsUpdatedAt: string | null;
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

const ROLE_RANK: Record<Role, number> = { ADMIN: 0, MANAGER: 1, MEMBER: 2 };
const EDITABLE_ROLES: Role[] = ['ADMIN', 'MEMBER'];

// Role → fixed status taxonomy (§2): one hue per role, never the accent.
const ROLE_STATUS: Record<Role, Status> = {
  ADMIN: 'warn',
  MANAGER: 'success',
  MEMBER: 'neutral',
};

const STATUS_FILTER = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
] as const;

const PLATFORM_META: Record<string, { label: string; iconSrc?: string }> = {
  darwin: { label: 'macOS', iconSrc: '/brand/apple.svg' },
  win32: { label: 'Windows', iconSrc: '/brand/windows.svg' },
  linux: { label: 'Linux' },
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function joinedDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getDate()).padStart(2, '0')} ${MONTH_SHORT[date.getMonth()]} ${String(date.getFullYear()).slice(-2)}`;
}

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
  const activate = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; provisioningStatus: 'ACTIVE' }>(
        `/v1/admin/users/${id}/activate`,
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

  const count = usersQ.data?.users.length;
  const scopeLine = usersQ.data ? SCOPE_LABEL[usersQ.data.scope] : 'Directory';

  const sorted = usersQ.data
    ? [...usersQ.data.users].sort(
        (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name),
      )
    : [];
  const activeCount = sorted.filter((u) => u.deactivatedAt === null).length;
  const offCount = sorted.length - activeCount;
  const pendingCount = sorted.filter(
    (u) => u.deactivatedAt === null && u.provisioningStatus === 'PENDING',
  ).length;
  const showDeviceHealth = canEdit;

  const colSpan = (canEdit ? 7 : 6) + (showDeviceHealth ? 2 : 0);

  return (
    <Page>
      <PageHeader
        eyebrow={`People · ${scopeLine}`}
        title="People"
        subtitle={
          count !== undefined
            ? `Showing ${count} ${count === 1 ? 'person' : 'people'} you can see`
            : 'Gathering the directory…'
        }
        actions={
          canEdit ? (
            <Toolbar>
              <Segmented
                aria-label="Filter by status"
                value={showDeactivated ? 'all' : 'active'}
                onChange={(v) => setShowDeactivated(v === 'all')}
                items={STATUS_FILTER}
              />
              <Button
                variant="primary"
                icon={<UserPlus size={15} strokeWidth={1.9} />}
                onClick={() => setInviting(true)}
              >
                Invite
              </Button>
            </Toolbar>
          ) : undefined
        }
      />

      {usersQ.data && (
        <Card variant="flush" className="rise rise-1">
          <StatRow>
            <Stat label="Active" value={String(activeCount)} />
            {canEdit && <Stat label="Pending setup" value={String(pendingCount)} />}
            <Stat label="Deactivated" value={String(offCount)} />
            <Stat label="Total" value={String(sorted.length)} />
          </StatRow>
        </Card>
      )}

      {canEdit && inviting && (
        <InviteForm
          onClose={() => setInviting(false)}
          onCreated={() => {
            setInviting(false);
            qc.invalidateQueries({ queryKey: ['admin', 'users'] });
          }}
        />
      )}

      <Card variant="flush" className="rise rise-2">
        {usersQ.isLoading ? (
          <SkeletonTable rows={6} />
        ) : usersQ.isError ? (
          <EmptyState
            tone="danger"
            icon={<UsersIcon size={22} strokeWidth={1.6} />}
            title="Couldn’t load people"
            description={(usersQ.error as Error).message}
            action={
              <Button variant="soft" onClick={() => usersQ.refetch()}>
                Try again
              </Button>
            }
          />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={22} strokeWidth={1.6} />}
            title="No people yet"
            description="Nobody is visible in your current scope."
          />
        ) : (
          <div className="usr-table-wrap">
            <Table density="comfortable" className={showDeviceHealth ? 'usr-table usr-table--device' : 'usr-table'}>
              <colgroup>
                <col className="usr-col-person" />
                <col className="usr-col-role" />
                <col className="usr-col-status" />
                <col className="usr-col-team" />
                <col className="usr-col-shift" />
                {showDeviceHealth && <col className="usr-col-device" />}
                {showDeviceHealth && <col className="usr-col-permissions" />}
                <col className="usr-col-joined" />
                {canEdit && <col className="usr-col-actions" />}
              </colgroup>
              <THead>
                <Tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Team</Th>
                  <Th>Shift</Th>
                  {showDeviceHealth && <Th>Device</Th>}
                  {showDeviceHealth && <Th>Permissions</Th>}
                  <Th align="right">Joined</Th>
                  {canEdit && <Th align="right">{''}</Th>}
                </Tr>
              </THead>
              <Tbody>
                {sorted.map((u) => (
                  <PersonRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === me.id}
                    canEdit={canEdit}
                    colSpan={colSpan}
                    showDeviceHealth={showDeviceHealth}
                    teams={teamsQ.data?.teams ?? []}
                    teamName={teamName(u.teamId)}
                    shifts={shiftsQ.data?.shifts ?? []}
                    shiftName={shiftName(u.shiftId)}
                    busy={
                      (patch.isPending && patch.variables?.id === u.id) ||
                      (deactivate.isPending && deactivate.variables === u.id) ||
                      (reactivate.isPending && reactivate.variables === u.id) ||
                      (activate.isPending && activate.variables === u.id)
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
                    onActivate={() => activate.mutate(u.id)}
                  />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>
    </Page>
  );
}

interface RowProps {
  user: AdminUser;
  isSelf: boolean;
  canEdit: boolean;
  colSpan: number;
  showDeviceHealth: boolean;
  teams: Team[];
  teamName: string;
  shifts: Shift[];
  shiftName: string;
  busy: boolean;
  error: string | null;
  onSave: (patch: Partial<{ name: string; role: Role; teamId: string | null; shiftId: string | null }>) => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onActivate: () => void;
}

function PersonRow({
  user,
  isSelf,
  canEdit,
  colSpan,
  showDeviceHealth,
  teams,
  teamName,
  shifts,
  shiftName,
  busy,
  error,
  onSave,
  onDeactivate,
  onReactivate,
  onActivate,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role === 'MANAGER' ? 'MEMBER' : user.role);
  const [teamId, setTeamId] = useState<string>(user.teamId ?? '');
  const [shiftId, setShiftId] = useState<string>(user.shiftId ?? '');

  function save() {
    const next: Partial<{ name: string; role: Role; teamId: string | null; shiftId: string | null }> = {};
    if (name.trim() && name.trim() !== user.name) next.name = name.trim();
    if (user.role !== 'MANAGER' && role !== user.role) next.role = role;
    const nextTeam = teamId === '' ? null : teamId;
    if (nextTeam !== (user.teamId ?? null)) next.teamId = nextTeam;
    const nextShift = shiftId === '' ? null : shiftId;
    if (nextShift !== (user.shiftId ?? null)) next.shiftId = nextShift;
    if (Object.keys(next).length > 0) onSave(next);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
    setName(user.name);
    setRole(user.role === 'MANAGER' ? 'MEMBER' : user.role);
    setTeamId(user.teamId ?? '');
    setShiftId(user.shiftId ?? '');
  }

  const isDeactivated = user.deactivatedAt !== null;
  const isPending = !isDeactivated && user.provisioningStatus === 'PENDING';
  const teamLockedByManagement = user.role === 'MANAGER' && Boolean(user.managesTeamId);

  const joined = joinedDateLabel(user.createdAt);

  return (
    <>
      <Tr
        rail={isSelf ? 'accent' : undefined}
        className={isDeactivated ? 'usr-row-off' : undefined}
      >
        {/* Person: avatar + name (+ You) + email --------------------------- */}
        <Td>
          {editing ? (
            <div className="usr-person-edit">
              <Avatar name={user.name} src={user.avatarUrl ?? undefined} size={32} />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
                aria-label="Name"
              />
            </div>
          ) : (
            <Identity
              avatar={<Avatar name={user.name} src={user.avatarUrl ?? undefined} size={32} />}
              name={
                <span className="usr-name-line">
                  {user.name}
                  {isSelf && <Tag status="info" className="usr-you">You</Tag>}
                </span>
              }
              subtitle={user.email}
            />
          )}
        </Td>

        {/* Role ----------------------------------------------------------- */}
        <Td>
          {editing ? (
            user.role === 'MANAGER' ? (
              <Tag status={ROLE_STATUS[user.role]}>{user.role}</Tag>
            ) : (
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
                {EDITABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            )
          ) : (
            <span className="usr-role-stack">
              <Tag status={ROLE_STATUS[user.role]}>{user.role}</Tag>
              {user.managesTeamName && <span className="ui-t-small ui-ink-3">Manages {user.managesTeamName}</span>}
            </span>
          )}
        </Td>

        {/* Status --------------------------------------------------------- */}
        <Td>
          <Tag status={isDeactivated ? 'neutral' : isPending ? 'warn' : 'success'} dot>
            {isDeactivated ? 'Deactivated' : isPending ? 'Pending' : 'Active'}
          </Tag>
        </Td>

        {/* Team ----------------------------------------------------------- */}
        <Td>
          {editing ? (
            <span className="usr-role-stack">
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team" disabled={teamLockedByManagement}>
                <option value="">— no team —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              {teamLockedByManagement && <span className="ui-t-small ui-ink-3">Locked to managed team</span>}
            </span>
          ) : (
            teamName
          )}
        </Td>

        {/* Shift ---------------------------------------------------------- */}
        <Td>
          {editing ? (
            <Select value={shiftId} onChange={(e) => setShiftId(e.target.value)} aria-label="Shift">
              <option value="">— no shift —</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : (
            shiftName
          )}
        </Td>

        {/* Device --------------------------------------------------------- */}
        {showDeviceHealth && (
          <Td>
            <DeviceCell user={user} />
          </Td>
        )}

        {/* Permissions ---------------------------------------------------- */}
        {showDeviceHealth && (
          <Td>
            <PermissionCell user={user} />
          </Td>
        )}

        {/* Joined --------------------------------------------------------- */}
        <Td mono className="usr-joined">{joined}</Td>

        {/* Actions -------------------------------------------------------- */}
        {canEdit && (
          <Td align="right" className="usr-action-cell">
            <div className="usr-actions">
              {editing ? (
                <>
                  <IconButton
                    icon={<X size={15} strokeWidth={1.9} />}
                    aria-label="Cancel"
                    onClick={cancel}
                    disabled={busy}
                  />
                  <IconButton
                    icon={<Check size={15} strokeWidth={2.2} />}
                    aria-label="Save"
                    variant="primary"
                    loading={busy}
                    onClick={save}
                  />
                </>
              ) : (
                <>
                  {!isDeactivated && (
                    <IconButton
                      icon={<Pencil size={14} strokeWidth={1.9} />}
                      aria-label="Edit person"
                      onClick={() => setEditing(true)}
                      disabled={busy}
                    />
                  )}
                  {isPending && (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy}
                      onClick={onActivate}
                      icon={<UserCheck size={14} strokeWidth={1.9} />}
                    >
                      Activate
                    </Button>
                  )}
                  {isDeactivated ? (
                    <IconButton
                      icon={<UserCheck size={14} strokeWidth={1.9} />}
                      aria-label="Reactivate"
                      title="Reactivate this person"
                      variant="soft"
                      loading={busy}
                      onClick={onReactivate}
                    />
                  ) : !isSelf ? (
                    <IconButton
                      icon={<UserMinus size={14} strokeWidth={1.9} />}
                      aria-label="Deactivate"
                      title="Deactivate this person"
                      variant="danger"
                      loading={busy}
                      onClick={() => {
                        if (window.confirm(`Deactivate ${user.name}? Their history stays for reports, but they can't log in until you reactivate.`)) {
                          onDeactivate();
                        }
                      }}
                    />
                  ) : null}
                </>
              )}
            </div>
          </Td>
        )}
      </Tr>
      {error && (
        <tr className="usr-row-err">
          <Td colSpan={colSpan}>
            <Banner status="danger">{error}</Banner>
          </Td>
        </tr>
      )}
    </>
  );
}

function DeviceCell({ user }: { user: AdminUser }) {
  const meta = user.agentPlatform ? PLATFORM_META[user.agentPlatform] ?? { label: user.agentPlatform } : null;
  if (!meta) return <span className="usr-device-empty">No heartbeat</span>;
  const version = user.agentVersion ? `v${user.agentVersion.replace(/^v/u, '')}` : 'Version unknown';

  return (
    <span className="usr-device">
      <span className="usr-device-icon" aria-hidden>
        {meta.iconSrc ? (
          <img src={meta.iconSrc} alt="" />
        ) : (
          <span className="usr-device-fallback">{meta.label.slice(0, 2).toUpperCase()}</span>
        )}
      </span>
      <span className="usr-device-copy">
        <span className="usr-device-name">{meta.label}</span>
        <span className="usr-device-version">{version}</span>
      </span>
    </span>
  );
}

function PermissionCell({ user }: { user: AdminUser }) {
  const screen = screenPermissionTag(user);
  const access = accessibilityPermissionTag(user);
  return (
    <div className="usr-permissions">
      <Tag status={screen.status} title={screen.title}>
        {screen.label}
      </Tag>
      <Tag status={access.status} title={access.title}>
        {access.label}
      </Tag>
    </div>
  );
}

function screenPermissionTag(user: AdminUser): { label: string; status: Status; title: string } {
  if (!user.agentPlatform) return { label: 'Screen ?', status: 'neutral', title: 'No desktop heartbeat yet.' };
  if (user.agentPlatform !== 'darwin') {
    return {
      label: 'Screen N/A',
      status: 'neutral',
      title: 'No Screen Recording permission is required on this OS.',
    };
  }
  if (!user.agentPermissionsUpdatedAt || !user.agentScreenPermissionState) {
    return { label: 'Screen ?', status: 'neutral', title: 'Waiting for a newer Timo heartbeat.' };
  }
  if (user.agentScreenPermissionState === 'ok') return { label: 'Screen OK', status: 'success', title: 'Screen Recording is ready.' };
  if (user.agentScreenPermissionState === 'needs-restart') {
    return { label: 'Screen restart', status: 'warn', title: 'Permission changed; Timo needs a restart.' };
  }
  if (user.agentScreenPermissionState === 'needs-settings') {
    return { label: 'Screen off', status: 'danger', title: 'Screen Recording is denied or restricted.' };
  }
  return { label: 'Screen grant', status: 'warn', title: 'Screen Recording has not been granted yet.' };
}

function accessibilityPermissionTag(user: AdminUser): { label: string; status: Status; title: string } {
  if (!user.agentPlatform) return { label: 'Access ?', status: 'neutral', title: 'No desktop heartbeat yet.' };
  if (user.agentPlatform !== 'darwin') {
    return {
      label: 'Access N/A',
      status: 'neutral',
      title: 'No Accessibility permission is required on this OS.',
    };
  }
  if (!user.agentPermissionsUpdatedAt || user.agentAccessibilityTrusted == null) {
    return { label: 'Access ?', status: 'neutral', title: 'Waiting for a newer Timo heartbeat.' };
  }
  if (!user.agentAccessibilityTrusted) return { label: 'Access off', status: 'danger', title: 'Accessibility is not granted.' };
  if (!user.agentAccessibilityReady) {
    return { label: 'Access restart', status: 'warn', title: 'Accessibility is granted, but Timo needs a restart.' };
  }
  if (user.agentAccessibilityRecording && !user.agentAccessibilityHookRunning) {
    return { label: 'Access restart', status: 'danger', title: 'Timo is tracking, but the input hook is not running.' };
  }
  return { label: 'Access OK', status: 'success', title: 'Accessibility is ready.' };
}

// -----------------------------------------------------------------------------
// Invite form — a calm Card above the roster. Escape cancels the email field,
// errors render in a Banner. Same mutation + contract.

function InviteForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const m = useMutation({
    mutationFn: (vars: { email: string; name: string; role: Role }) =>
      api<AdminUser>('/v1/admin/users', { method: 'POST', json: { ...vars, activityRoleTitle: 'OTHER' } }),
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
    <Card
      title="Invite someone"
      action={
        <IconButton icon={<X size={16} strokeWidth={1.9} />} aria-label="Close" onClick={onClose} />
      }
      className="rise rise-1"
    >
      <form onSubmit={submit} className="usr-invite-form">
        <Field label="Email" className="usr-invite-email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            placeholder="pat@example.com"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
        </Field>
        <Field label="Name" className="usr-invite-name">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            placeholder="Pat Khanna"
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="MEMBER">MEMBER</option>
            <option value="MANAGER">MANAGER</option>
            <option value="ADMIN">ADMIN</option>
          </Select>
        </Field>
        <div className="usr-invite-actions">
          <Button variant="ghost" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={<UserPlus size={15} strokeWidth={1.9} />}
            loading={m.isPending}
            disabled={!email || !name}
          >
            {m.isPending ? 'Inviting…' : 'Invite'}
          </Button>
        </div>
      </form>
      {err && (
        <Banner status="danger" className="usr-invite-banner">
          {err}
        </Banner>
      )}
      <p className="usr-invite-hint ui-t-small">
        A temporary password is generated server-side. Share it manually for v1 — magic-link onboarding is on the roadmap.
      </p>
    </Card>
  );
}

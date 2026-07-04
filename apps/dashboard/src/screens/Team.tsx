import './team.css';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, Pencil, RotateCcw, Save, Users, X } from 'lucide-react';
import type {
  PatchTeamMemberSettingsRequest,
  ScreenshotIntervalMin,
  ShiftDto,
  TeamMemberSettingsDto,
  TeamSettingsResponse,
  WorkspacePolicyDto,
} from '@grind/types';
import { SCREENSHOT_INTERVAL_OPTIONS } from '@grind/types';
import { api } from '../lib/api';
import { useMe, type Role } from '../lib/auth';
import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Identity,
  Page,
  PageHeader,
  Select,
  SkeletonTable,
  Stat,
  StatRow,
  Table,
  Tag,
  Tbody,
  Td,
  Textarea,
  Th,
  THead,
  Toolbar,
  Tr,
} from '../ui';
import { TeamMemberDetailDrawer } from './Reports';

type PatchField = keyof PatchTeamMemberSettingsRequest;
type PendingField = PatchField | 'settings';
type PendingEdit = { userId: string; field: PendingField } | null;
type RowDraft = {
  userId: string;
  shiftId: string | null;
  screenshotIntervalMin: ScreenshotIntervalMin;
  idleThresholdMin: number;
} | null;
type MonitoringRisk = 'NORMAL' | 'CAUTION' | 'HIGH';
type MonitoringTiming = { screenshotIntervalMin: number; idleThresholdMin: number };

const TEAM_SETTINGS_QUERY_KEY = ['admin', 'team-member-settings'] as const;

const IDLE_THRESHOLD_OPTIONS = [1, 3, 5, 10, 15, 30, 45, 60, 120];

export function TeamScreen() {
  const queryClient = useQueryClient();
  const meQ = useMe();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit>(null);
  const [rowDraft, setRowDraft] = useState<RowDraft>(null);
  const [riskPrompt, setRiskPrompt] = useState<{
    member: TeamMemberSettingsDto;
    patch: PatchTeamMemberSettingsRequest;
    next: MonitoringTiming;
  } | null>(null);

  const settingsQ = useQuery({
    queryKey: TEAM_SETTINGS_QUERY_KEY,
    queryFn: () => api<TeamSettingsResponse>('/v1/admin/team-member-settings'),
  });
  const policyQ = useQuery({
    queryKey: ['admin', 'workspace-policy'],
    queryFn: () => api<WorkspacePolicyDto>('/v1/admin/workspace-policy'),
  });

  const updateMember = useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: PatchTeamMemberSettingsRequest }) =>
      api<TeamMemberSettingsDto>(`/v1/admin/team-member-settings/${userId}`, { method: 'PATCH', json: patch }),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData<TeamSettingsResponse | undefined>(TEAM_SETTINGS_QUERY_KEY, (current) => {
        if (!current) return current;
        return {
          ...current,
          members: current.members.map((member) => (member.id === updated.id ? updated : member)),
        };
      });
      setRowDraft((current) => (current?.userId === variables.userId ? null : current));
      setRiskPrompt((current) => (current?.member.id === variables.userId ? null : current));
    },
    onSettled: () => setPendingEdit(null),
  });

  const members = settingsQ.data?.members ?? [];
  const shifts = settingsQ.data?.shifts ?? [];
  const summary = useMemo(() => summarizeMembers(members), [members]);
  const policy = policyQ.data;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = localDateKey();
  const drawerFrom = addLocalDays(today, -6);

  function patchMember(userId: string, field: PendingField, patch: PatchTeamMemberSettingsRequest) {
    setPendingEdit({ userId, field });
    updateMember.mutate({ userId, patch });
  }

  function startRowEdit(member: TeamMemberSettingsDto) {
    setRowDraft({
      userId: member.id,
      shiftId: member.shiftId,
      screenshotIntervalMin: member.screenshotIntervalMin,
      idleThresholdMin: member.idleThresholdMin,
    });
  }

  function updateRowDraft(memberId: string, patch: Partial<NonNullable<RowDraft>>) {
    setRowDraft((current) => (current?.userId === memberId ? { ...current, ...patch } : current));
  }

  function saveRowEdit(member: TeamMemberSettingsDto) {
    if (!rowDraft || rowDraft.userId !== member.id) return;
    const patch: PatchTeamMemberSettingsRequest = {};
    if (rowDraft.shiftId !== member.shiftId) patch.shiftId = rowDraft.shiftId;
    if (rowDraft.screenshotIntervalMin !== member.screenshotIntervalMin) {
      patch.screenshotIntervalMin = rowDraft.screenshotIntervalMin;
    }
    if (rowDraft.idleThresholdMin !== member.idleThresholdMin) {
      patch.idleThresholdMin = rowDraft.idleThresholdMin;
    }
    if (Object.keys(patch).length === 0) {
      setRowDraft(null);
      return;
    }
    const previousTiming = {
      screenshotIntervalMin: member.screenshotIntervalMin,
      idleThresholdMin: member.idleThresholdMin,
    };
    const nextTiming = {
      screenshotIntervalMin: rowDraft.screenshotIntervalMin,
      idleThresholdMin: rowDraft.idleThresholdMin,
    };
    if (
      monitoringTimingChanged(previousTiming, nextTiming) &&
      monitoringRiskLevel(nextTiming) === 'HIGH'
    ) {
      setRiskPrompt({ member, patch, next: nextTiming });
      return;
    }
    patchMember(member.id, 'settings', patch);
  }

  const draftRisk = rowDraft ? monitoringRiskLevel(rowDraft) : 'NORMAL';

  return (
    <Page className="tm-page">
      <PageHeader
        eyebrow="Manager workspace"
        title="Team Settings"
        subtitle="Edit each member's shift, screenshot cadence, and idle-break threshold."
        actions={
          <Toolbar>
            <Button
              variant="secondary"
              size="md"
              icon={<RotateCcw size={14} strokeWidth={1.8} />}
              onClick={() => settingsQ.refetch()}
              loading={settingsQ.isRefetching}
            >
              Refresh
            </Button>
          </Toolbar>
        }
      />

      {settingsQ.isError && (
        <Banner
          status="danger"
          action={
            <Button variant="ghost" size="sm" onClick={() => settingsQ.refetch()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load team settings: {(settingsQ.error as Error).message}
        </Banner>
      )}

      {updateMember.isError && (
        <Banner status="danger">Couldn&apos;t save the member setting: {(updateMember.error as Error).message}</Banner>
      )}

      {rowDraft && draftRisk === 'HIGH' && (
        <Banner status="danger">
          This edit sets 1-minute monitoring for a member. Saving it requires an audit reason.
        </Banner>
      )}

      {rowDraft && draftRisk === 'CAUTION' && (
        <Banner status="warn">
          This edit uses a short monitoring cadence. It will be audit-logged when saved.
        </Banner>
      )}

      {settingsQ.isLoading && (
        <Card variant="flush">
          <SkeletonTable rows={6} />
        </Card>
      )}

      {settingsQ.data && members.length === 0 && (
        <Card variant="flush">
          <EmptyState
            icon={<Users size={22} strokeWidth={1.8} />}
            title="No team members to configure"
            description="Members appear here after they are assigned to a team you manage."
          />
        </Card>
      )}

      {settingsQ.data && members.length > 0 && (
        <>
          <Card variant="flush" className="tm-summary-card">
            <StatRow>
              <Stat label="Members" value={members.length} hint={settingsQ.data.scope === 'workspace' ? 'workspace scope' : 'team scope'} />
              <Stat label="Assigned shifts" value={summary.assignedShifts} hint={`${summary.unassignedShifts} unassigned`} />
              <Stat label="Screenshots" value={formatCadence(summary.avgScreenshotIntervalMin)} hint="average cadence" />
              <Stat label="Idle break" value={formatCadence(summary.avgIdleThresholdMin)} hint="average threshold" />
              <Stat label="Capture" value={policy ? captureCount(policy) : '-'} hint={policy ? `${policy.retentionDaysScreenshots}d retention` : 'loading policy'} />
            </StatRow>
          </Card>

          <Card variant="flush" className="tm-members-card">
            <div className="tm-card-head">
              <div>
                <h2 className="ui-t-title">Members</h2>
                <p className="ui-t-small">Edit settings with the pencil, then confirm with the tick.</p>
              </div>
              <Tag mono>{members.length}</Tag>
            </div>
            <TeamSettingsTable
              members={members}
              shifts={shifts}
              currentUserId={meQ.data?.id ?? null}
              currentUserRole={meQ.data?.role ?? null}
              pendingEdit={pendingEdit}
              rowDraft={rowDraft}
              onStartEdit={startRowEdit}
              onCancelEdit={() => setRowDraft(null)}
              onDraftChange={updateRowDraft}
              onSaveEdit={saveRowEdit}
              onOpenMember={setSelectedUserId}
            />
          </Card>
        </>
      )}

      {selectedUserId && (
        <TeamMemberDetailDrawer
          userId={selectedUserId}
          initialFrom={drawerFrom}
          initialTo={today}
          today={today}
          tz={tz}
          onClose={() => setSelectedUserId(null)}
        />
      )}

      {riskPrompt && (
        <TeamMonitoringRiskModal
          member={riskPrompt.member}
          next={riskPrompt.next}
          saving={updateMember.isPending}
          error={updateMember.error instanceof Error ? updateMember.error.message : null}
          onClose={() => setRiskPrompt(null)}
          onConfirm={(auditReason) => patchMember(riskPrompt.member.id, 'settings', { ...riskPrompt.patch, auditReason })}
        />
      )}
    </Page>
  );
}

function TeamSettingsTable({
  members,
  shifts,
  currentUserId,
  currentUserRole,
  pendingEdit,
  rowDraft,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSaveEdit,
  onOpenMember,
}: {
  members: TeamMemberSettingsDto[];
  shifts: ShiftDto[];
  currentUserId: string | null;
  currentUserRole: Role | null;
  pendingEdit: PendingEdit;
  rowDraft: RowDraft;
  onStartEdit: (member: TeamMemberSettingsDto) => void;
  onCancelEdit: () => void;
  onDraftChange: (memberId: string, patch: Partial<NonNullable<RowDraft>>) => void;
  onSaveEdit: (member: TeamMemberSettingsDto) => void;
  onOpenMember: (userId: string) => void;
}) {
  return (
    <div className="tm-table-wrap">
      <Table density="compact" stickyHead className="tm-members-table">
        <THead>
          <Tr>
            <Th className="tm-col-member">Member</Th>
            <Th className="tm-col-shift" align="center">Shift</Th>
            <Th className="tm-col-shot" align="center">Screenshot interval</Th>
            <Th className="tm-col-idle" align="center">Idle break</Th>
            <Th className="tm-col-manager" align="center">Manager</Th>
            <Th className="tm-col-action" align="center">Action</Th>
          </Tr>
        </THead>
        <Tbody>
          {members.map((member) => {
            const draft = rowDraft?.userId === member.id ? rowDraft : null;
            const editing = Boolean(draft);
            const rowBusy = isPending(pendingEdit, member.id, 'settings');
            const shiftId = draft ? draft.shiftId : member.shiftId;
            const screenshotIntervalMin = draft ? draft.screenshotIntervalMin : member.screenshotIntervalMin;
            const idleThresholdMin = draft ? draft.idleThresholdMin : member.idleThresholdMin;
            const shift = shifts.find((s) => s.id === shiftId) ?? null;
            const isCurrentUser = member.id === currentUserId;
            const selfEditLocked = isCurrentUser && currentUserRole !== 'ADMIN';

            return (
              <Tr key={member.id} className="tm-member-row">
                <Td className="tm-col-member">
                  <Identity
                    avatar={<Avatar name={member.name} src={member.avatarUrl ?? undefined} size={32} />}
                    name={isCurrentUser ? `${member.name} (you)` : member.name}
                    subtitle={member.team?.name ?? member.email}
                  />
                </Td>
                <Td className="tm-col-shift" align="center">
                  {editing ? (
                    <ShiftSelect
                      memberName={member.name}
                      value={shiftId}
                      shifts={shifts}
                      busy={rowBusy}
                      onChange={(nextShiftId) => onDraftChange(member.id, { shiftId: nextShiftId })}
                    />
                  ) : (
                    <SettingValue value={shift?.name ?? 'No shift'} />
                  )}
                </Td>
                <Td className="tm-col-shot" align="center">
                  {editing ? (
                    <CadenceSelect
                      ariaLabel={`${member.name} screenshot interval`}
                      value={screenshotIntervalMin}
                      options={SCREENSHOT_INTERVAL_OPTIONS}
                      busy={rowBusy}
                      prefix="Every"
                      onChange={(next) => onDraftChange(member.id, { screenshotIntervalMin: next })}
                    />
                  ) : (
                    <SettingValue label="Every" value={formatCadence(screenshotIntervalMin)} />
                  )}
                </Td>
                <Td className="tm-col-idle" align="center">
                  {editing ? (
                    <CadenceSelect
                      ariaLabel={`${member.name} idle break threshold`}
                      value={idleThresholdMin}
                      options={IDLE_THRESHOLD_OPTIONS}
                      busy={rowBusy}
                      prefix="After"
                      onChange={(next) => onDraftChange(member.id, { idleThresholdMin: next })}
                    />
                  ) : (
                    <SettingValue label="After" value={formatCadence(idleThresholdMin)} />
                  )}
                </Td>
                <Td className="tm-col-manager" align="center">
                  <div className="tm-stack tm-stack--center">
                    <span className="ui-t-strong">{member.manager?.name ?? 'No manager'}</span>
                    <span className="ui-t-small ui-ink-3">{member.manager?.email ?? 'Workspace scope'}</span>
                  </div>
                </Td>
                <Td className="tm-col-action" align="center">
                  <div className="tm-row-actions">
                    {editing ? (
                      <>
                        <IconButton
                          icon={<X size={15} strokeWidth={1.9} />}
                          aria-label="Cancel settings edit"
                          disabled={rowBusy}
                          onClick={onCancelEdit}
                        />
                        <IconButton
                          icon={<Check size={15} strokeWidth={2.2} />}
                          aria-label="Save settings"
                          variant="primary"
                          loading={rowBusy}
                          onClick={() => onSaveEdit(member)}
                        />
                      </>
                    ) : (
                      <>
                        <IconButton
                          icon={<Pencil size={14} strokeWidth={1.9} />}
                          aria-label={
                            selfEditLocked
                              ? `Admin controls ${member.name} settings`
                              : `Edit ${member.name} settings`
                          }
                          title={selfEditLocked ? 'Admins control your settings' : undefined}
                          disabled={Boolean(pendingEdit) || Boolean(rowDraft) || selfEditLocked}
                          onClick={() => onStartEdit(member)}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<ArrowUpRight size={14} strokeWidth={1.8} />}
                          onClick={() => onOpenMember(member.id)}
                        >
                          Open
                        </Button>
                      </>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </div>
  );
}

function SettingValue({ label, value }: { label?: string; value: string }) {
  return (
    <span className="tm-setting-display">
      {label && <span className="tm-setting-display__label">{label}</span>}
      <span className="tm-setting-display__value">{value}</span>
    </span>
  );
}

function ShiftSelect({
  memberName,
  value,
  shifts,
  busy,
  onChange,
}: {
  memberName: string;
  value: string | null;
  shifts: ShiftDto[];
  busy: boolean;
  onChange: (shiftId: string | null) => void;
}) {
  return (
    <div className="tm-setting-control">
      <Select
        value={value ?? ''}
        aria-label={`${memberName} shift`}
        disabled={busy}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">No shift</option>
        {shifts.map((shift) => (
          <option key={shift.id} value={shift.id}>
            {shift.name}
          </option>
        ))}
      </Select>
      {busy && <span className="tm-saving ui-t-small">Saving</span>}
    </div>
  );
}

function CadenceSelect<T extends number>({
  ariaLabel,
  value,
  options,
  busy,
  prefix,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: readonly T[];
  busy: boolean;
  prefix: 'Every' | 'After';
  onChange: (value: T) => void;
}) {
  return (
    <div className="tm-setting-control">
      <Select
        value={String(value)}
        aria-label={ariaLabel}
        disabled={busy}
        onChange={(e) => onChange(Number(e.target.value) as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {prefix} {formatCadence(option)}
          </option>
        ))}
      </Select>
      {busy && <span className="tm-saving ui-t-small">Saving</span>}
    </div>
  );
}

function isPending(pending: PendingEdit, userId: string, field: PendingField): boolean {
  return pending?.userId === userId && pending.field === field;
}

function summarizeMembers(members: TeamMemberSettingsDto[]) {
  const assignedShifts = members.filter((member) => member.shiftId).length;
  const screenshotTotal = members.reduce((sum, member) => sum + member.screenshotIntervalMin, 0);
  const idleTotal = members.reduce((sum, member) => sum + member.idleThresholdMin, 0);
  return {
    assignedShifts,
    unassignedShifts: members.length - assignedShifts,
    avgScreenshotIntervalMin: members.length ? Math.round(screenshotTotal / members.length) : 0,
    avgIdleThresholdMin: members.length ? Math.round(idleTotal / members.length) : 0,
  };
}

function captureCount(policy: WorkspacePolicyDto): string {
  const enabled = [policy.captureApps, policy.captureTitles, policy.captureUrls].filter(Boolean).length;
  return `${enabled}/3`;
}

function formatCadence(minutes: number): string {
  if (minutes <= 0) return '-';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function monitoringRiskLevel(timing: MonitoringTiming): MonitoringRisk {
  if (timing.screenshotIntervalMin === 1 || timing.idleThresholdMin === 1) return 'HIGH';
  if (timing.screenshotIntervalMin === 2 || timing.idleThresholdMin <= 3) return 'CAUTION';
  return 'NORMAL';
}

function monitoringTimingChanged(previous: MonitoringTiming, next: MonitoringTiming): boolean {
  return previous.screenshotIntervalMin !== next.screenshotIntervalMin ||
    previous.idleThresholdMin !== next.idleThresholdMin;
}

function TeamMonitoringRiskModal({
  member,
  next,
  saving,
  error,
  onClose,
  onConfirm,
}: {
  member: TeamMemberSettingsDto;
  next: MonitoringTiming;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (auditReason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return createPortal(
    <div className="ui-overlay tm-risk-layer" role="presentation" onMouseDown={onClose}>
      <section className="tm-risk-modal" role="dialog" aria-modal="true" aria-labelledby="tm-risk-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="tm-risk-head">
          <div className="tm-risk-title">
            <div className="ui-t-eyebrow">Monitoring audit</div>
            <h2 id="tm-risk-title" className="ui-t-title">Confirm 1-minute monitoring</h2>
            <p className="ui-t-small">
              {member.name}: screenshots every {formatCadence(next.screenshotIntervalMin)}, idle after {formatCadence(next.idleThresholdMin)}.
            </p>
          </div>
          <IconButton aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="tm-risk-body">
          <Banner status="danger">
            1-minute monitoring is exceptional. Record why this member needs it before saving.
          </Banner>
          <Field label="Audit reason" hint="Required. Visible to admins in policy audit history.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Example: temporary review window approved by Ops."
              autoFocus
            />
          </Field>
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <footer className="tm-risk-foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Save size={15} />}
            onClick={() => onConfirm(trimmed)}
            loading={saving}
            disabled={!trimmed}
          >
            Save with audit
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addLocalDays(key: string, delta: number): string {
  const parts = key.split('-').map(Number);
  const y = parts[0] ?? new Date().getFullYear();
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return localDateKey(new Date(y, m - 1, d + delta));
}

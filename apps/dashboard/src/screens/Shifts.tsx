import './shifts.css';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarDays, Check, Clock3, Mail, Pencil, Plus, Trash2, UserRound, Users2, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Shift, ShiftSchedule, DaySchedule, WeekdayKey } from '../lib/types';
import {
  Page,
  PageHeader,
  Card,
  Toolbar,
  Button,
  IconButton,
  Field,
  Input,
  Select,
  Toggle,
  Tag,
  Table,
  THead,
  Tbody,
  Tr,
  Th,
  Td,
  Banner,
  EmptyState,
  Skeleton,
  Avatar,
  List,
} from '../ui';

const WEEK: { key: WeekdayKey; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const NINE_TO_SIX: ShiftSchedule = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
  sun: null,
};

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
  teamId: string | null;
  shiftId?: string | null;
}

/**
 * /shifts — ADMIN-only screen, composed entirely from the shared "Quiet
 * Datasheet" kit (Page / PageHeader / Card / Field / Table / Tag / Button …).
 * The page contributes layout only; every colour, type, border and radius
 * comes from the kit + tokens. Behaviour is untouched: same queries,
 * mutations, save-diff logic, time pickers, day toggles, clamps and all
 * loading / empty / error states.
 *
 * Workspace shifts define each weekday's working window + a buffer during which
 * the agent's "Ready to work?" toast keeps nudging the user. Assigned per-user
 * via /people.
 */
export function ShiftsScreen() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'shifts'],
    queryFn: () => api<{ shifts: Shift[] }>('/v1/admin/shifts'),
  });
  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; schedule: ShiftSchedule; bufferMin: number }) =>
      api<Shift>('/v1/admin/shifts', { method: 'POST', json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'shifts'] });
      setCreateOpen(false);
    },
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }> }) =>
      api<Shift>(`/v1/admin/shifts/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/shifts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'shifts'] });
      setSelectedShiftId(null);
    },
  });
  const patchUser = useMutation({
    mutationFn: (vars: { id: string; shiftId: string | null }) =>
      api<AdminUser>(`/v1/admin/users/${vars.id}`, { method: 'PATCH', json: { shiftId: vars.shiftId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['admin', 'shifts'] });
    },
  });

  const count = q.data?.shifts.length ?? 0;
  const shifts = q.data?.shifts ?? [];
  const users = usersQ.data?.users ?? [];
  const selectedShift = selectedShiftId ? shifts.find((shift) => shift.id === selectedShiftId) ?? null : null;
  const selectedShiftMembers = selectedShift ? users.filter((user) => user.shiftId === selectedShift.id) : [];
  const selectedShiftAvailableUsers = selectedShift ? users.filter((user) => user.shiftId !== selectedShift.id) : [];
  const assignedMembers = shifts.reduce((sum, shift) => sum + shift.memberCount, 0);
  const avgBufferMin = shifts.length
    ? Math.round(shifts.reduce((sum, shift) => sum + shift.bufferMin, 0) / shifts.length)
    : null;
  const avgWorkingDays = shifts.length
    ? shifts.reduce((sum, shift) => sum + countWorkingDays(shift.schedule), 0) / shifts.length
    : null;

  return (
    <Page className="shf-page">
      <PageHeader
        eyebrow="Workspace · Admin"
        title="Shifts"
        subtitle="Define when each shift starts and how long the agent should nudge before going quiet."
        actions={
          <Toolbar>
            <Tag mono>{q.data ? `${count} ${count === 1 ? 'shift' : 'shifts'}` : '—'}</Tag>
            <Button
              variant="primary"
              icon={<Plus size={14} strokeWidth={2.2} />}
              onClick={() => setCreateOpen(true)}
            >
              New shift
            </Button>
          </Toolbar>
        }
      />

      <div className="shf-stack">
        {q.data && (
          <section className="shf-overview ui-rise-1" aria-label="Shift overview">
            <div className="shf-overview__lead">
              <span className="ui-t-eyebrow">Configured shifts</span>
              <strong className="ui-t-num">{count}</strong>
              <span className="ui-t-small">
                {count === 0 ? 'No schedule templates yet' : 'Templates available for people assignment'}
              </span>
            </div>
            <ShiftMetric label="Assigned members" value={assignedMembers} hint="people using shifts" />
            <ShiftMetric label="Avg buffer" value={avgBufferMin == null ? '—' : `${avgBufferMin}m`} hint="nudge window" />
            <ShiftMetric
              label="Avg week"
              value={avgWorkingDays == null ? '—' : `${formatNumber(avgWorkingDays)}/7`}
              hint="working days"
            />
          </section>
        )}

        <section className="shf-stack ui-rise-2">
          <div className="shf-section-head">
            <div>
              <span className="ui-t-eyebrow">Saved shifts</span>
              <h2 className="shf-section-title ui-t-title">Schedule templates</h2>
            </div>
            <Tag mono>{q.data ? count : '—'}</Tag>
          </div>

          {q.isLoading && (
            <Card variant="flush">
              <div className="shf-skel">
                <Skeleton w="40%" h={16} />
                <Skeleton w="100%" h={120} />
              </div>
            </Card>
          )}
          {q.isError && (
            <Banner status="danger">Couldn&apos;t load shifts: {(q.error as Error).message}</Banner>
          )}
          {q.data && q.data.shifts.length === 0 && (
            <EmptyState
              icon={<CalendarClock size={22} strokeWidth={1.7} />}
              title="No shifts yet"
              description="Create a shift, then assign it to people from the team settings or people directory."
              action={
                <Button
                  variant="primary"
                  icon={<Plus size={14} strokeWidth={2.2} />}
                  onClick={() => setCreateOpen(true)}
                >
                  New shift
                </Button>
              }
            />
          )}
          {q.data && q.data.shifts.length > 0 && (
            <div className="shf-stack">
              {q.data.shifts.map((sh) => (
                <ShiftRow
                  key={sh.id}
                  shift={sh}
                  busy={(patch.isPending && patch.variables?.id === sh.id) || (del.isPending && del.variables === sh.id)}
                  error={
                    (patch.isError && patch.variables?.id === sh.id
                      ? (patch.error as Error | ApiError).message
                      : null) ||
                    (del.isError && del.variables === sh.id ? (del.error as Error | ApiError).message : null)
                  }
                  onPatch={(p) => patch.mutate({ id: sh.id, patch: p })}
                  onDelete={() => del.mutate(sh.id)}
                  onOpen={() => setSelectedShiftId(sh.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {createOpen && (
        <ShiftCreateModal
          busy={create.isPending}
          error={create.isError ? (create.error as Error | ApiError).message : null}
          onCreate={(vars) => create.mutate(vars)}
          onClose={() => setCreateOpen(false)}
        />
      )}

      {selectedShift && (
        <ShiftDrawer
          shift={selectedShift}
          members={selectedShiftMembers}
          availableUsers={selectedShiftAvailableUsers}
          shiftBusy={patch.isPending && patch.variables?.id === selectedShift.id}
          shiftError={patch.isError && patch.variables?.id === selectedShift.id ? (patch.error as Error | ApiError).message : null}
          usersLoading={usersQ.isLoading}
          usersError={usersQ.isError ? (usersQ.error as Error | ApiError).message : null}
          busyUserId={patchUser.isPending ? patchUser.variables?.id ?? null : null}
          assignmentError={patchUser.isError ? (patchUser.error as Error | ApiError).message : null}
          onPatch={(nextPatch) => patch.mutate({ id: selectedShift.id, patch: nextPatch })}
          onAdd={(userId) => patchUser.mutate({ id: userId, shiftId: selectedShift.id })}
          onRemove={(userId) => patchUser.mutate({ id: userId, shiftId: null })}
          onClose={() => setSelectedShiftId(null)}
        />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Create modal — name/buffer fields + the 7-day editor in a focused layer
// ---------------------------------------------------------------------------

function ShiftMetric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="shf-overview__metric">
      <span className="ui-t-eyebrow">{label}</span>
      <strong className="ui-t-strong">{value}</strong>
      <span className="ui-t-small">{hint}</span>
    </div>
  );
}

function ShiftCreateModal({
  busy,
  error,
  onCreate,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  onCreate: (vars: { name: string; schedule: ShiftSchedule; bufferMin: number }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<ShiftSchedule>(NINE_TO_SIX);
  const [bufferMin, setBufferMin] = useState(30);

  const workingDays = WEEK.filter((w) => schedule[w.key] !== null).length;

  return createPortal(
    <div className="shf-modal-layer" role="presentation" onMouseDown={onClose}>
      <form
        className="shf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shf-create-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          onCreate({ name: name.trim(), schedule, bufferMin });
        }}
      >
        <div className="shf-modal-head">
          <div>
            <span className="ui-t-eyebrow">New shift</span>
            <h2 id="shf-create-title" className="shf-modal-title ui-t-title">
              Create schedule template
            </h2>
          </div>
          <div className="shf-modal-head-actions">
            <Tag mono>{workingDays} / 7 days on</Tag>
            <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close new shift dialog" onClick={onClose} />
          </div>
        </div>

        <div className="shf-modal-body">
          <div className="shf-modal-intro">
            <span className="ui-t-small">
              Set the weekly working window once. People assigned to this shift keep historical reports truthful when schedules change later.
            </span>
          </div>

          <div className="shf-modal-fields">
            <Field label="Shift name">
              <Input
                type="text"
                placeholder="e.g. Day Shift"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
              />
            </Field>
            <Field label="Buffer (min)" hint="Nudge window">
              <Input
                type="number"
                min={0}
                max={240}
                step={5}
                value={bufferMin}
                onChange={(e) => setBufferMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
                className="shf-num"
              />
            </Field>
          </div>

          <ScheduleEditor value={schedule} onChange={setSchedule} />

          {error && <Banner status="danger">{error}</Banner>}
        </div>

        <div className="shf-modal-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} strokeWidth={2.2} />}
            loading={busy}
            disabled={busy || !name.trim()}
          >
            Create shift
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Row — collapsed summary Card with an expandable inline editor
// ---------------------------------------------------------------------------

function ShiftRow({
  shift,
  busy,
  error,
  onPatch,
  onDelete,
  onOpen,
}: {
  shift: Shift;
  busy: boolean;
  error: string | null;
  onPatch: (patch: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }>) => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(shift.name);
  const [schedule, setSchedule] = useState<ShiftSchedule>(shift.schedule);
  const [bufferMin, setBufferMin] = useState(shift.bufferMin);
  const [pendingDelete, setPendingDelete] = useState(false);

  function save() {
    const next: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }> = {};
    if (name.trim() && name.trim() !== shift.name) next.name = name.trim();
    if (bufferMin !== shift.bufferMin) next.bufferMin = bufferMin;
    if (JSON.stringify(schedule) !== JSON.stringify(shift.schedule)) next.schedule = schedule;
    if (Object.keys(next).length === 0) {
      setEditing(false);
      return;
    }
    onPatch(next);
    setEditing(false);
  }

  const workingDays = WEEK.filter((w) => shift.schedule[w.key] !== null).length;
  const canOpen = !editing && !pendingDelete;

  return (
    <Card
      className="shf-shift-card"
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={canOpen ? onOpen : undefined}
      onKeyDown={
        canOpen
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
    >
      <div className="shf-row-head">
        <div className="shf-row-id">
          <Avatar name={shift.name || 'Shift'} size={32} />
          {editing ? (
            <Input
              type="text"
              className="shf-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          ) : (
            <div className="shf-row-main">
              <span className="ui-t-strong">{shift.name}</span>
              <span className="ui-t-small ui-ink-2 shf-summary">{summariseSchedule(shift.schedule)}</span>
            </div>
          )}
        </div>

        <div className="shf-row-side">
          <div className="shf-meta">
            <Tag mono>
              {shift.memberCount} member{shift.memberCount === 1 ? '' : 's'}
            </Tag>
            {editing ? (
              <Field label="Buffer" className="shf-buffer-edit">
                <Input
                  type="number"
                  min={0}
                  max={240}
                  step={5}
                  value={bufferMin}
                  onChange={(e) => setBufferMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
                  className="shf-num"
                />
              </Field>
            ) : (
              <Tag mono>Buffer {shift.bufferMin}m</Tag>
            )}
            <Tag status="info">
              {workingDays} working {workingDays === 1 ? 'day' : 'days'}
            </Tag>
          </div>

          <div className="shf-actions" onClick={(event) => event.stopPropagation()}>
            {editing ? (
              <>
                <Button variant="ghost" size="sm" icon={<X size={14} strokeWidth={2} />} onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" icon={<Check size={14} strokeWidth={2.2} />} loading={busy} onClick={save}>
                  Save
                </Button>
              </>
            ) : pendingDelete ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" loading={busy} onClick={onDelete}>
                  {busy ? 'Deleting' : 'Confirm delete'}
                </Button>
              </>
            ) : (
              <>
                <IconButton icon={<Pencil size={14} strokeWidth={2} />} aria-label="Edit shift" size="sm" onClick={() => setEditing(true)} />
                <IconButton icon={<Trash2 size={14} strokeWidth={2} />} aria-label="Delete shift" size="sm" variant="danger" onClick={() => setPendingDelete(true)} />
              </>
            )}
          </div>
        </div>
      </div>

      {error && (
        <Banner status="danger" className="shf-row-banner">
          {error}
        </Banner>
      )}

      <div className="shf-row-body">
        {editing ? (
          <div onClick={(event) => event.stopPropagation()}>
            <ScheduleEditor value={schedule} onChange={setSchedule} />
          </div>
        ) : (
          <ScheduleReadout schedule={shift.schedule} />
        )}
      </div>
    </Card>
  );
}

function ShiftDrawer({
  shift,
  members,
  availableUsers,
  shiftBusy,
  shiftError,
  usersLoading,
  usersError,
  busyUserId,
  assignmentError,
  onPatch,
  onAdd,
  onRemove,
  onClose,
}: {
  shift: Shift;
  members: AdminUser[];
  availableUsers: AdminUser[];
  shiftBusy: boolean;
  shiftError: string | null;
  usersLoading: boolean;
  usersError: string | null;
  busyUserId: string | null;
  assignmentError: string | null;
  onPatch: (patch: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }>) => void;
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
  onClose: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(shift.name);
  const [schedule, setSchedule] = useState<ShiftSchedule>(shift.schedule);
  const [bufferMin, setBufferMin] = useState(shift.bufferMin);
  const activeSchedule = editing ? schedule : shift.schedule;
  const activeBufferMin = editing ? bufferMin : shift.bufferMin;
  const workingDays = countWorkingDays(activeSchedule);

  function resetDraft() {
    setName(shift.name);
    setSchedule(shift.schedule);
    setBufferMin(shift.bufferMin);
  }

  function saveDraft() {
    const next: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }> = {};
    if (name.trim() && name.trim() !== shift.name) next.name = name.trim();
    if (bufferMin !== shift.bufferMin) next.bufferMin = bufferMin;
    if (JSON.stringify(schedule) !== JSON.stringify(shift.schedule)) next.schedule = schedule;
    if (Object.keys(next).length > 0) onPatch(next);
    setEditing(false);
  }

  return createPortal(
    <div className="shf-drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        className="shf-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shf-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="shf-drawer-head">
          <div className="shf-drawer-id">
            <Avatar name={shift.name || 'Shift'} size={40} />
            <div>
              <span className="ui-t-eyebrow">Shift</span>
              <h2 id="shf-drawer-title" className="shf-drawer-title ui-t-title">
                {editing ? name || shift.name : shift.name}
              </h2>
            </div>
          </div>
          <div className="shf-drawer-head-actions">
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={14} strokeWidth={2} />}
                  onClick={() => {
                    resetDraft();
                    setEditing(false);
                  }}
                  disabled={shiftBusy}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Check size={14} strokeWidth={2.2} />}
                  loading={shiftBusy}
                  onClick={saveDraft}
                  disabled={!name.trim()}
                >
                  Save
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil size={14} strokeWidth={2} />}
                onClick={() => {
                  resetDraft();
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close shift drawer" onClick={onClose} />
          </div>
        </header>

        <div className="shf-drawer-body">
          <section className="shf-drawer-facts" aria-label="Shift facts">
            <ShiftFact icon={<Users2 size={17} />} label="Members" value={members.length} hint={memberCountLabel(members.length)} />
            <ShiftFact icon={<Clock3 size={17} />} label="Buffer" value={`${activeBufferMin}m`} hint="nudge window" />
            <ShiftFact icon={<CalendarDays size={17} />} label="Week" value={`${workingDays}/7`} hint="working days" />
          </section>

          <section className="shf-drawer-section">
            <div className="shf-drawer-section-head">
              <div>
                <h3 className="ui-t-title">Schedule</h3>
                <span className="ui-t-small">{summariseSchedule(activeSchedule)}</span>
              </div>
              <Tag mono>{activeBufferMin}m buffer</Tag>
            </div>
            {shiftError && <Banner status="danger">{shiftError}</Banner>}
            {editing ? (
              <div className="shf-drawer-edit">
                <div className="shf-modal-fields">
                  <Field label="Shift name">
                    <Input
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={80}
                    />
                  </Field>
                  <Field label="Buffer (min)" hint="Nudge window">
                    <Input
                      type="number"
                      min={0}
                      max={240}
                      step={5}
                      value={bufferMin}
                      onChange={(event) => setBufferMin(Math.max(0, Math.min(240, Number(event.target.value) || 0)))}
                      className="shf-num"
                    />
                  </Field>
                </div>
                <ScheduleEditor value={schedule} onChange={setSchedule} />
              </div>
            ) : (
              <ScheduleReadout schedule={shift.schedule} />
            )}
          </section>

          <section className="shf-drawer-section">
            <div className="shf-drawer-section-head">
              <div>
                <h3 className="ui-t-title">Assigned members</h3>
                <span className="ui-t-small">Add or remove people from this shift.</span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={14} strokeWidth={2.1} />}
                onClick={() => setAddOpen(true)}
                disabled={usersLoading || availableUsers.length === 0}
              >
                Add
              </Button>
            </div>

            {usersError && <Banner status="danger">{usersError}</Banner>}
            {assignmentError && <Banner status="danger">{assignmentError}</Banner>}
            {usersLoading ? (
              <div className="shf-skel">
                <Skeleton w="100%" h={44} />
                <Skeleton w="100%" h={44} />
              </div>
            ) : members.length === 0 ? (
              <EmptyState
                icon={<UserRound size={22} strokeWidth={1.7} />}
                title="No members assigned"
                description="Add people to make this shift available in their day and reports."
              />
            ) : (
              <List className="shf-member-list">
                {members.map((member) => (
                  <div key={member.id} className="shf-member-row">
                    <Avatar name={member.name} size={32} />
                    <div className="shf-member-main">
                      <span className="ui-t-strong">{member.name}</span>
                      <span className="ui-t-small">
                        <Mail size={13} strokeWidth={1.8} aria-hidden /> {member.email}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<X size={13} strokeWidth={2} />}
                      loading={busyUserId === member.id}
                      disabled={Boolean(busyUserId)}
                      onClick={() => onRemove(member.id)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </List>
            )}
          </section>
        </div>

        {addOpen && (
          <ShiftAddMemberModal
            shift={shift}
            users={availableUsers}
            busyUserId={busyUserId}
            error={assignmentError}
            onAdd={(userId) => {
              onAdd(userId);
              setAddOpen(false);
            }}
            onClose={() => setAddOpen(false)}
          />
        )}
      </aside>
    </div>,
    document.body,
  );
}

function ShiftFact({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint: string }) {
  return (
    <div className="shf-fact">
      <span className="shf-fact__icon" aria-hidden>
        {icon}
      </span>
      <span className="ui-t-eyebrow">{label}</span>
      <strong className="ui-t-strong">{value}</strong>
      <span className="ui-t-small">{hint}</span>
    </div>
  );
}

function ShiftAddMemberModal({
  shift,
  users,
  busyUserId,
  error,
  onAdd,
  onClose,
}: {
  shift: Shift;
  users: AdminUser[];
  busyUserId: string | null;
  error: string | null;
  onAdd: (userId: string) => void;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState('');
  const canSubmit = Boolean(userId);

  return (
    <div className="shf-nested-layer" role="presentation" onMouseDown={onClose}>
      <form
        className="shf-modal shf-modal--small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shf-add-member-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onAdd(userId);
        }}
      >
        <div className="shf-modal-head">
          <div>
            <span className="ui-t-eyebrow">Add member</span>
            <h2 id="shf-add-member-title" className="shf-modal-title ui-t-title">
              {shift.name}
            </h2>
          </div>
          <IconButton icon={<X size={18} strokeWidth={1.9} />} aria-label="Close add member dialog" onClick={onClose} />
        </div>
        <div className="shf-modal-body">
          <Field label="Person">
            <Select value={userId} onChange={(event) => setUserId(event.target.value)} disabled={users.length === 0} required>
              <option value="" disabled>
                {users.length === 0 ? 'No people available' : 'Select a person'}
              </option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {roleLabel(user.role)}
                </option>
              ))}
            </Select>
          </Field>
          <Banner status="info">Adding a person moves them onto this shift.</Banner>
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <div className="shf-modal-actions">
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

// ---------------------------------------------------------------------------
// 7-day schedule editor (edit mode) — a compact Table
// ---------------------------------------------------------------------------

function ScheduleEditor({
  value,
  onChange,
}: {
  value: ShiftSchedule;
  onChange: (next: ShiftSchedule) => void;
}) {
  function setDay(day: WeekdayKey, next: DaySchedule | null) {
    onChange({ ...value, [day]: next });
  }

  return (
    <div className="shf-editor">
      <Table density="compact">
        <THead>
          <Tr>
            <Th>Day</Th>
            <Th>Working</Th>
            <Th>Window</Th>
          </Tr>
        </THead>
        <Tbody>
          {WEEK.map(({ key, label }) => {
            const day = value[key];
            const off = day === null;
            return (
              <Tr key={key} rail={off ? undefined : 'success'}>
                <Td>
                  <span className="ui-t-strong">{label}</span>
                </Td>
                <Td>
                  <label className="shf-toggle">
                    <Toggle
                      checked={!off}
                      onChange={(checked) => {
                        if (checked) setDay(key, day ?? { start: '09:00', end: '18:00' });
                        else setDay(key, null);
                      }}
                    />
                    <span className="ui-t-small ui-ink-2">{off ? 'Day off' : 'Working'}</span>
                  </label>
                </Td>
                <Td>
                  <div className="shf-times">
                    <Input
                      type="time"
                      value={day?.start ?? '09:00'}
                      disabled={off}
                      onChange={(e) => day && setDay(key, { ...day, start: e.target.value })}
                      className="shf-time"
                    />
                    <span className="ui-mono ui-ink-3" aria-hidden>→</span>
                    <Input
                      type="time"
                      value={day?.end ?? '18:00'}
                      disabled={off}
                      onChange={(e) => day && setDay(key, { ...day, end: e.target.value })}
                      className="shf-time"
                    />
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

// ---------------------------------------------------------------------------
// 7-day readout (collapsed view) — the week shape at a glance
// ---------------------------------------------------------------------------

function ScheduleReadout({ schedule }: { schedule: ShiftSchedule }) {
  return (
    <div className="shf-week">
      {WEEK.map(({ key, label }) => {
        const day = schedule[key];
        const off = day === null;
        return (
          <div key={key} className={`shf-day${off ? ' is-off' : ''}`}>
            <span className="ui-t-eyebrow shf-day-label">{label}</span>
            {off ? (
              <span className="ui-mono ui-ink-3">—</span>
            ) : (
              <>
                <span className="ui-mono shf-day-time">{day.start}</span>
                <span className="ui-mono ui-ink-3 shf-day-time">{day.end}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function summariseSchedule(s: ShiftSchedule): string {
  const working = WEEK.filter((w) => s[w.key] !== null);
  if (working.length === 0) return 'No working days';
  if (working.length === 7) return 'Every day';
  const allSameTimes = working.every(
    (w) =>
      s[w.key]?.start === s[working[0]!.key]!.start && s[w.key]?.end === s[working[0]!.key]!.end,
  );
  const days = working.map((w) => w.label).join(', ');
  if (allSameTimes) return `${days} · ${s[working[0]!.key]!.start}–${s[working[0]!.key]!.end}`;
  return `${working.length} working days`;
}

function countWorkingDays(s: ShiftSchedule): number {
  return WEEK.filter((w) => s[w.key] !== null).length;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function memberCountLabel(count: number): string {
  if (count === 0) return 'no assigned people';
  if (count === 1) return 'assigned person';
  return 'assigned people';
}

function roleLabel(role: AdminUser['role']): string {
  if (role === 'ADMIN') return 'Admin';
  if (role === 'MANAGER') return 'Manager';
  return 'Member';
}

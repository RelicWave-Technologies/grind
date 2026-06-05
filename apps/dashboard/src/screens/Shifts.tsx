import './shifts.css';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X, CalendarClock } from 'lucide-react';
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
  const q = useQuery({
    queryKey: ['admin', 'shifts'],
    queryFn: () => api<{ shifts: Shift[] }>('/v1/admin/shifts'),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; schedule: ShiftSchedule; bufferMin: number }) =>
      api<Shift>('/v1/admin/shifts', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }> }) =>
      api<Shift>(`/v1/admin/shifts/${vars.id}`, { method: 'PATCH', json: vars.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/shifts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'shifts'] }),
  });

  const count = q.data?.shifts.length ?? 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace · Admin"
        title="Shifts"
        subtitle="Define when each shift starts and how long the agent should nudge before going quiet."
        actions={
          <Toolbar>
            <Tag mono>{q.data ? `${count} ${count === 1 ? 'shift' : 'shifts'}` : '—'}</Tag>
          </Toolbar>
        }
      />

      <div className="shf-stack">
        <div className="ui-rise-1">
          <ShiftComposer
            busy={create.isPending}
            error={create.isError ? (create.error as Error | ApiError).message : null}
            onCreate={(vars) => create.mutate(vars)}
          />
        </div>

        <section className="shf-stack ui-rise-2">
          <span className="ui-t-eyebrow">Saved shifts</span>

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
              description="Create one above. Assign it to people from /people."
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
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Composer — a Card hosting name/buffer fields + the 7-day editor
// ---------------------------------------------------------------------------

function ShiftComposer({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onCreate: (vars: { name: string; schedule: ShiftSchedule; bufferMin: number }) => void;
}) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<ShiftSchedule>(NINE_TO_SIX);
  const [bufferMin, setBufferMin] = useState(30);

  const workingDays = WEEK.filter((w) => schedule[w.key] !== null).length;

  function reset() {
    setName('');
    setSchedule(NINE_TO_SIX);
    setBufferMin(30);
  }

  return (
    <Card title="New shift" action={<Tag mono>{workingDays} / 7 days on</Tag>}>
      <form
        className="shf-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onCreate({ name: name.trim(), schedule, bufferMin });
          reset();
        }}
      >
        <div className="shf-form-top">
          <Field label="Shift name" className="shf-grow">
            <Input
              type="text"
              placeholder="e.g. Day Shift"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
              onChange={(e) => setBufferMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
              className="shf-num"
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} strokeWidth={2.2} />}
            loading={busy}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating' : 'Create shift'}
          </Button>
        </div>

        <ScheduleEditor value={schedule} onChange={setSchedule} />

        {error && <Banner status="danger">{error}</Banner>}
      </form>
    </Card>
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
}: {
  shift: Shift;
  busy: boolean;
  error: string | null;
  onPatch: (patch: Partial<{ name: string; schedule: ShiftSchedule; bufferMin: number }>) => void;
  onDelete: () => void;
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

  return (
    <Card>
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

          <div className="shf-actions">
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
          <ScheduleEditor value={schedule} onChange={setSchedule} />
        ) : (
          <ScheduleReadout schedule={shift.schedule} />
        )}
      </div>
    </Card>
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
    <Card variant="flush" className="shf-editor">
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
    </Card>
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

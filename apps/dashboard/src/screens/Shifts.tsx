import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil, Check, X, Clock4 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Shift, ShiftSchedule, DaySchedule, WeekdayKey } from '../lib/types';

const WEEK: { key: WeekdayKey; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const EMPTY: ShiftSchedule = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
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
 * /shifts — ADMIN-only screen. Workspace shifts define each weekday's
 * working window + a buffer during which the agent's "Ready to work?"
 * toast keeps nudging the user. Assigned per-user via /users.
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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">Shifts</h1>
          <p className="secondary page-sub">
            Define when each shift starts and how long the agent should nudge before going quiet.
          </p>
        </div>
      </header>

      <ShiftComposer
        busy={create.isPending}
        error={create.isError ? (create.error as Error | ApiError).message : null}
        onCreate={(vars) => create.mutate(vars)}
      />

      <section className="card teams-card" style={{ padding: 0, marginTop: 16 }}>
        {q.isLoading && <div className="empty">Loading…</div>}
        {q.isError && (
          <div className="empty empty-error">
            Couldn&apos;t load shifts: {(q.error as Error).message}
          </div>
        )}
        {q.data && q.data.shifts.length === 0 && (
          <div className="empty">
            <div className="empty-icon" aria-hidden>
              <Clock4 size={22} strokeWidth={1.8} />
            </div>
            <div className="empty-title">No shifts yet</div>
            <div>Create one above. Assign it to people from /people.</div>
          </div>
        )}
        {q.data && q.data.shifts.length > 0 && (
          <ul className="teams-list">
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
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
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

  function reset() {
    setName('');
    setSchedule(NINE_TO_SIX);
    setBufferMin(30);
  }

  return (
    <form
      className="card composer-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate({ name: name.trim(), schedule, bufferMin });
        reset();
      }}
    >
      <div className="composer-row" style={{ marginBottom: 16 }}>
        <input
          type="text"
          className="composer-input"
          placeholder="Shift name (e.g. Day Shift)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        <label className="composer-buffer">
          <span className="field-label" style={{ marginRight: 8 }}>Buffer (min)</span>
          <input
            type="number"
            min={0}
            max={240}
            step={5}
            value={bufferMin}
            onChange={(e) => setBufferMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
            className="composer-num"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
          <Plus size={14} strokeWidth={2.2} />
          <span>{busy ? 'Creating…' : 'Create shift'}</span>
        </button>
      </div>
      <ScheduleEditor value={schedule} onChange={setSchedule} />
      {error && <div className="approval-error" style={{ marginTop: 10 }}>{error}</div>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Row (collapsed summary; expandable inline editor)
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

  return (
    <li className="team-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div className="team-main" style={{ flex: 1 }}>
          {editing ? (
            <input
              type="text"
              className="team-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          ) : (
            <div className="team-name">{shift.name}</div>
          )}
          <div className="team-meta callout secondary">
            {shift.memberCount} member{shift.memberCount === 1 ? '' : 's'}
            {' · '}
            {editing ? (
              <span>
                Buffer:{' '}
                <input
                  type="number"
                  min={0}
                  max={240}
                  step={5}
                  value={bufferMin}
                  onChange={(e) =>
                    setBufferMin(Math.max(0, Math.min(240, Number(e.target.value) || 0)))
                  }
                  className="composer-num"
                  style={{ width: 64 }}
                />{' '}
                min
              </span>
            ) : (
              <span>Buffer {shift.bufferMin} min</span>
            )}
            {' · '}
            <span className="tertiary">{summariseSchedule(shift.schedule)}</span>
          </div>
          {error && <div className="approval-error team-error">{error}</div>}
        </div>

        <div className="team-actions">
          {editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
                <X size={14} strokeWidth={2} /> Cancel
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={busy}>
                <Check size={14} strokeWidth={2.2} /> Save
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
                <Pencil size={14} strokeWidth={2} /> Edit
              </button>
              <button type="button" className="btn-ghost team-delete" onClick={() => setPendingDelete(true)}>
                <Trash2 size={14} strokeWidth={2} /> Delete
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <ScheduleEditor value={schedule} onChange={setSchedule} />
      ) : (
        <ScheduleReadout schedule={shift.schedule} />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 7-day schedule editor (edit mode) + readout (collapsed view)
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
    <div className="schedule-grid">
      {WEEK.map(({ key, label }) => {
        const day = value[key];
        const off = day === null;
        return (
          <div key={key} className={`schedule-row${off ? ' is-off' : ''}`}>
            <div className="schedule-day">{label}</div>
            <label className="schedule-toggle">
              <input
                type="checkbox"
                checked={!off}
                onChange={(e) => {
                  if (e.target.checked) setDay(key, day ?? { start: '09:00', end: '18:00' });
                  else setDay(key, null);
                }}
              />
              <span>{off ? 'Day off' : 'Working day'}</span>
            </label>
            <div className="schedule-times">
              <input
                type="time"
                value={day?.start ?? '09:00'}
                disabled={off}
                onChange={(e) => day && setDay(key, { ...day, start: e.target.value })}
                className="schedule-time"
              />
              <span className="secondary">–</span>
              <input
                type="time"
                value={day?.end ?? '18:00'}
                disabled={off}
                onChange={(e) => day && setDay(key, { ...day, end: e.target.value })}
                className="schedule-time"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScheduleReadout({ schedule }: { schedule: ShiftSchedule }) {
  return (
    <div className="schedule-readout">
      {WEEK.map(({ key, label }) => {
        const day = schedule[key];
        return (
          <div key={key} className={`schedule-chip${day === null ? ' is-off' : ''}`}>
            <span className="schedule-chip-day">{label}</span>
            <span className="schedule-chip-time tabular">
              {day === null ? '—' : `${day.start} – ${day.end}`}
            </span>
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

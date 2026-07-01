import './metoday.css';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { hasCapability, isManagerOrAbove } from '../lib/auth';
import type { DayBlock, DayInsight, WorkspaceUser } from '../lib/types';
import { fmtDayLabel, todayKey, addDays, fmtDurationMs } from '../lib/format';
import { DayRibbon } from '../components/DayRibbon';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { EntryRow } from '../components/EntryRow';
import type { TaskOption } from '../components/TaskCombo';
import {
  Page,
  PageHeader,
  Card,
  Toolbar,
  Select,
  DateStepper,
  IconButton,
  Tag,
  Banner,
  SkeletonTable,
} from '../ui';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
}

/**
 * /edit-time — the employee's own day, composed STRICTLY from the shared kit
 * (`src/ui`) so it reads as one product with the other 12 pages. The page file
 * contributes layout only: a `PageHeader` (eyebrow → title → toolbar), a
 * day-stage `Card` hosting the timeline ribbon + heatmap, and a flush `Card`
 * wrapping the editable timesheet. No bespoke colour / type / border / shadow
 * lives here — those come only from the kit + tokens. The page CSS (`myd-`
 * prefix) is pure LAYOUT.
 *
 * The rich, stateful functional core is PRESERVED byte-for-byte: the
 * shift-bounded DayRibbon, the ActivityHeatmap, and the editable
 * EntryRow timesheet (with TimePopover / TaskCombo / attendee pickers) — every
 * prop, handler, mutation, and piece of state is unchanged. The timesheet keeps
 * the exact 6-column `<table>` contract EntryRow renders into.
 *
 * Scoped writes: members edit only themselves; managers/admins can edit users
 * exposed by the server's team/workspace scope. The agent create/sync contract
 * stays self-owned; this page only drives dashboard metadata/manual edits.
 *
 * The mutation set:
 *   - PATCH /v1/time-entries/:id      (tracked + APPROVED MANUAL rows)
 *   - POST  /v1/time-requests         (gap rows → new request)
 *   - PATCH /v1/time-requests/:id     (pending edit)
 *   - POST  /v1/time-requests/:id/cancel (pending withdraw)
 *
 * Each mutation invalidates the day query so the ribbon + heatmap +
 * pending overlay all stay in sync without manual `setState`.
 */
export function MeTodayScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const search = useSearch({ from: '/authed/edit-time' });
  const qc = useQueryClient();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const searchDate =
    typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : todayKey();
  const searchUserId = typeof search.userId === 'string' && search.userId.length > 0 ? search.userId : me.id;
  const focusRequestId = typeof search.requestId === 'string' && search.requestId.length > 0 ? search.requestId : null;
  const focusStartMs = parseSearchEpochMs(search.focusStart);
  const focusEndMs = parseSearchEpochMs(search.focusEnd);
  const [date, setDate] = useState<string>(searchDate);
  const [targetUserId, setTargetUserId] = useState<string>(searchUserId);
  const showPicker = isManagerOrAbove(me.role);
  const editable = targetUserId === me.id || hasCapability(me, 'time.team.edit');

  useEffect(() => {
    setDate(searchDate);
  }, [searchDate]);

  useEffect(() => {
    setTargetUserId(searchUserId);
  }, [searchUserId]);

  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    enabled: showPicker,
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  // Workspace directory for the attendee picker. Available to every
  // authenticated user (server-side handler is /v1/workspace/users) — needed
  // so MEMBERs can tag co-workers on MEETING/MANUAL rows without leaking
  // role/team metadata.
  const wsUsersQ = useQuery({
    queryKey: ['workspace', 'users'],
    queryFn: () => api<{ users: WorkspaceUser[] }>('/v1/workspace/users'),
    staleTime: 5 * 60_000,
  });
  const workspaceUsers = wsUsersQ.data?.users ?? [];

  // Lark tasks — fetched once for the day view; cached for 5 min so the
  // TaskCombos open instantly. Falls back to empty list if Lark isn't
  // configured (the user gets the "Untracked" sentinel anyway).
  const tasksQ = useQuery({
    queryKey: ['lark', 'my-tasks'],
    queryFn: async () => {
      try {
        return await api<{ tasks: TaskOption[] }>('/v1/lark/my-tasks');
      } catch {
        return { tasks: [] };
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const dayKey = ['insights', 'day', date, tz, targetUserId];
  const dayQ = useQuery({
    queryKey: dayKey,
    queryFn: () => {
      const params = new URLSearchParams({ date, tz });
      if (targetUserId !== me.id) params.set('userId', targetUserId);
      return api<DayInsight>(`/v1/insights/day?${params.toString()}`);
    },
    refetchInterval: date === todayKey() ? 15_000 : false,
  });

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: dayKey });
  }, [qc, dayKey]);

  // ---- Mutations (self-only) -------------------------------------------------

  const patchEntry = useMutation({
    mutationFn: (vars: { id: string; larkTaskGuid: string | null; notes: string; attendeeIds?: string[] }) => {
      const body: Record<string, unknown> = { larkTaskGuid: vars.larkTaskGuid, notes: vars.notes };
      if (vars.attendeeIds !== undefined) body.attendeeIds = vars.attendeeIds;
      return api(`/v1/time-entries/${vars.id}`, { method: 'PATCH', json: body });
    },
    onSuccess: invalidate,
  });

  const createRequest = useMutation({
    mutationFn: (vars: { requestedStart: number; requestedEnd: number; larkTaskGuid: string | null; taskSummary: string | null; reason: string; attendeeIds?: string[] }) => {
      const body: Record<string, unknown> = {
        clientUuid: `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        requestedStart: new Date(vars.requestedStart).toISOString(),
        requestedEnd: new Date(vars.requestedEnd).toISOString(),
        larkTaskGuid: vars.larkTaskGuid,
        taskSummary: vars.taskSummary,
        reason: vars.reason,
      };
      if (vars.attendeeIds && vars.attendeeIds.length > 0) body.attendeeIds = vars.attendeeIds;
      if (targetUserId !== me.id) body.userId = targetUserId;
      return api('/v1/time-requests', { method: 'POST', json: body });
    },
    onSuccess: invalidate,
  });

  const patchRequest = useMutation({
    mutationFn: (vars: { id: string; requestedStart: number; requestedEnd: number; larkTaskGuid: string | null; taskSummary: string | null; reason: string; attendeeIds?: string[] }) => {
      const body: Record<string, unknown> = {
        requestedStart: new Date(vars.requestedStart).toISOString(),
        requestedEnd: new Date(vars.requestedEnd).toISOString(),
        larkTaskGuid: vars.larkTaskGuid,
        taskSummary: vars.taskSummary,
        reason: vars.reason,
      };
      if (vars.attendeeIds !== undefined) body.attendeeIds = vars.attendeeIds;
      return api(`/v1/time-requests/${vars.id}`, { method: 'PATCH', json: body });
    },
    onSuccess: invalidate,
  });

  const cancelRequest = useMutation({
    mutationFn: (id: string) => api(`/v1/time-requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const deleteManualEntry = useMutation({
    mutationFn: (id: string) => api(`/v1/time-entries/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  // ---- Click-to-fill from ribbon --------------------------------------------

  // When the user clicks a gap span on the ribbon, find the matching gap
  // block and snap THAT row's composer to the clicked range. We use a
  // tick counter as the "fire" signal so re-clicking the same span still
  // triggers a re-seed.
  const [gapPreset, setGapPreset] = useState<{
    blockKey: string;
    range: { startedAt: number; endedAt: number };
    tick: number;
  } | null>(null);

  // Bar↔row link: when the ribbon hovers a block, highlight the matching
  // table row. Uses a single piece of state so only one row can be lit at
  // a time. Row keys match the ribbon's: `entry-<id>`, `pending-<id>`, `gap-…`.
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);

  // Stable row key for a block — must match the keys used in the table below.
  const rowKeyFor = useCallback((b: { kind: string; startedAt: number; endedAt: number; timeEntryId?: string; requestId?: string }): string => {
    if (b.kind === 'GAP') return `gap-${b.startedAt}-${b.endedAt}`;
    if (b.kind === 'PENDING') return `pending-${b.requestId}`;
    if (b.kind === 'IDLE_TRIMMED') return `idle-${b.startedAt}`;
    return `entry-${b.timeEntryId ?? b.startedAt}`;
  }, []);

  // Scroll a row into view, flash-highlight it, and drop the cursor straight
  // into its reason/notes field so the user can type immediately.
  const focusRow = useCallback((rowId: string) => {
    setHighlightedRowId(rowId);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // .et-reason is the notes (tracked) / reason (gap, pending) input. Focus
      // without re-scrolling so the smooth scroll above isn't interrupted.
      row.querySelector<HTMLInputElement>('.et-reason')?.focus({ preventScroll: true });
    });
  }, []);

  // Click a slot on the ribbon → focus its row. For an editable GAP, also seed
  // the composer to the WHOLE gap (the user then trims it in the dropdowns).
  function onRibbonClick(epochMs: number) {
    if (!dayQ.data) return;
    const hit = dayQ.data.blocks.find((b) => epochMs >= b.startedAt && epochMs < b.endedAt);
    if (!hit) return;
    focusRow(rowKeyFor(hit));
    if (editable && hit.kind === 'GAP') {
      setGapPreset({
        blockKey: `${hit.startedAt}-${hit.endedAt}`,
        range: { startedAt: hit.startedAt, endedAt: hit.endedAt },
        tick: (gapPreset?.tick ?? 0) + 1,
      });
    }
  }

  const deepLinkFocusToken = `${targetUserId}:${date}:${focusRequestId ?? ''}:${focusStartMs ?? ''}:${focusEndMs ?? ''}`;
  const lastDeepLinkFocusRef = useRef<string | null>(null);

  useEffect(() => {
    const day = dayQ.data;
    if (!day || (!focusRequestId && focusStartMs === null)) return;

    const token = `${deepLinkFocusToken}:${day.blocks.length}:${day.recentRejected.length}`;
    if (lastDeepLinkFocusRef.current === token) return;

    const requestBlock = focusRequestId
      ? day.blocks.find((block) => block.requestId === focusRequestId)
      : undefined;
    const slotBlock = focusStartMs !== null
      ? day.blocks.find((block) => focusStartMs >= block.startedAt && focusStartMs < block.endedAt)
      : undefined;
    const rejectedRow = focusRequestId
      ? day.recentRejected.find((request) => request.id === focusRequestId)
      : undefined;

    const block = requestBlock ?? slotBlock;
    if (block) {
      lastDeepLinkFocusRef.current = token;
      focusRow(rowKeyFor(block));
      if (editable && block.kind === 'GAP') {
        const startedAt = Math.max(block.startedAt, focusStartMs ?? block.startedAt);
        const endedAt = Math.min(block.endedAt, focusEndMs ?? block.endedAt);
        if (endedAt > startedAt) {
          setGapPreset((previous) => ({
            blockKey: `${block.startedAt}-${block.endedAt}`,
            range: { startedAt, endedAt },
            tick: (previous?.tick ?? 0) + 1,
          }));
        }
      }
      return;
    }

    if (rejectedRow) {
      lastDeepLinkFocusRef.current = token;
      focusRow(`rejected-${rejectedRow.id}`);
    }
  }, [
    dayQ.data,
    deepLinkFocusToken,
    editable,
    focusEndMs,
    focusRequestId,
    focusRow,
    focusStartMs,
    rowKeyFor,
  ]);

  // ---- Derived view state ---------------------------------------------------

  const targetUser: AdminUser | undefined = useMemo(() => {
    if (targetUserId === me.id) return { id: me.id, name: me.name, email: me.email, role: me.role };
    return usersQ.data?.users.find((u) => u.id === targetUserId);
  }, [targetUserId, usersQ.data, me]);

  const now = Date.now();
  const tasks = tasksQ.data?.tasks ?? [];

  const isToday = date === todayKey();
  const tzLabel = tz.replace(/_/g, ' ');
  const isSelf = !targetUser || targetUser.id === me.id;
  const titleName = targetUser
    ? targetUser.id === me.id
      ? 'Edit Time'
      : `${targetUser.name.split(' ')[0]}’s Time`
    : 'Edit Time';

  const day = dayQ.data;

  return (
    <Page className="myd-page">
      <PageHeader
        eyebrow={`${tzLabel} · ${fmtDayLabel(date).toUpperCase()}`}
        title={titleName}
        subtitle={
          isSelf
            ? 'Review and edit your timesheet.'
            : targetUser
              ? `Editing ${targetUser.name}’s time with manager scope.`
              : 'Loading selected teammate…'
        }
        actions={
          <Toolbar className="myd-header-toolbar">
            {showPicker && usersQ.data && (
              <Select
                className="myd-user-select"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                aria-label="View someone's day"
              >
                {[...usersQ.data.users]
                  .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.role.toLowerCase()}`}
                    </option>
                  ))}
              </Select>
            )}
            <SingleDatePicker
              date={date}
              today={todayKey()}
              onChange={setDate}
              onPrev={() => setDate((d) => addDays(d, -1))}
              onNext={() => setDate((d) => addDays(d, 1))}
              nextDisabled={isToday}
            />
          </Toolbar>
        }
      />

      {dayQ.isError && (
        <Banner status="danger">Couldn’t load the day: {(dayQ.error as Error).message}</Banner>
      )}

      {dayQ.isLoading && (
        <div className="myd-stack">
          <Card className="ui-rise-1 myd-stage-card">
            <SkeletonTable rows={3} />
          </Card>
        </div>
      )}

      {day && (
        <div className="myd-stack">
          {/* ---- Day stage: timeline ribbon + activity heatmap ---- */}
          <Card className="ui-rise-1 myd-stage-card">
            <div className="myd-stage-top">
              {day.shift && (
                <div className="myd-stage-meta">
                  <Tag status="neutral" mono>
                    {day.shift.name} · {day.shift.start}–{day.shift.end}
                  </Tag>
                  <span className="ui-t-small myd-stage-note">Shift-bounded</span>
                </div>
              )}
              {!day.shift && (
                <div className="myd-stage-meta">
                  <Tag status="neutral" mono>Full day</Tag>
                </div>
              )}
              <div className="myd-legend">
                <Tag status="success" dot>Tracked</Tag>
                <Tag status="info" dot>Meeting</Tag>
                <Tag status="warn" dot>Manual</Tag>
                <Tag status="danger" dot>Pending</Tag>
                <Tag status="neutral" dot>Idle</Tag>
              </div>
            </div>

            <div className="myd-canvas">
              <DayRibbon
                day={day}
                now={now}
                editable={editable}
                onClickEpoch={onRibbonClick}
                onHoverRowId={setHighlightedRowId}
              />
              {day.activity && day.activity.buckets.length > 0 && (
                <ActivityHeatmap day={day} heatmap={day.activity} />
              )}
            </div>

            {!editable && (
              <div className="myd-readonly">
                <Banner status="info">
                  Viewing {targetUser?.name}’s day without edit access.
                </Banner>
              </div>
            )}
          </Card>

          {/* ---- Timesheet: flush Card hosting the exact 6-col EntryRow table ---- */}
          <Card variant="flush" className="ui-rise-2 myd-sheet-card">
            <div className="myd-sheet-head">
              <div className="myd-sheet-titling">
                <h2 className="ui-t-h3">Timesheet</h2>
                <span className="ui-t-eyebrow">{day.blocks.length} entries</span>
              </div>
            </div>

            <div className="myd-table-wrap">
              <table className="myd-table">
                <thead>
                  <tr>
                    <th className="ui-t-eyebrow myd-col-kind">Kind</th>
                    <th className="ui-t-eyebrow myd-col-time">Time</th>
                    <th className="ui-t-eyebrow myd-col-duration">Duration</th>
                    <th className="ui-t-eyebrow myd-col-task">Task</th>
                    <th className="ui-t-eyebrow">Notes / Reason</th>
                    <th className="ui-t-eyebrow myd-col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {/* One sorted partition: gap · tracked · meeting · manual ·
                      idle · pending, contiguous and non-overlapping. */}
                  {day.blocks.map((b) => {
                    if (b.kind === 'GAP') {
                      const blockKey = `${b.startedAt}-${b.endedAt}`;
                      const rowId = `gap-${blockKey}`;
                      return (
                        <EntryRow
                          key={rowId}
                          rowId={rowId}
                          highlighted={highlightedRowId === rowId}
                          kind="gap"
                          block={b}
                          tasks={tasks}
                          disabled={!editable}
                          workspaceUsers={workspaceUsers}
                          selfId={me.id}
                          preset={gapPreset && gapPreset.blockKey === blockKey ? gapPreset.range : undefined}
                          presetTick={gapPreset && gapPreset.blockKey === blockKey ? gapPreset.tick : 0}
                          onCreate={async (vars) => {
                            await createRequest.mutateAsync(vars);
                          }}
                        />
                      );
                    }
                    if (b.kind === 'PENDING') {
                      const rowId = `pending-${b.requestId}`;
                      return (
                        <EntryRow
                          key={rowId}
                          rowId={rowId}
                          highlighted={highlightedRowId === rowId}
                          kind="pending"
                          block={b}
                          tasks={tasks}
                          disabled={!editable}
                          workspaceUsers={workspaceUsers}
                          selfId={me.id}
                          onPatch={async (vars) => {
                            await patchRequest.mutateAsync(vars);
                          }}
                          onWithdraw={async (id) => {
                            await cancelRequest.mutateAsync(id);
                          }}
                        />
                      );
                    }
                    if (b.kind === 'IDLE_TRIMMED') {
                      const rowId = `idle-${b.startedAt}`;
                      return (
                        <tr
                          key={rowId}
                          data-row-id={rowId}
                          className={`et-row entry-row-idle_trimmed${highlightedRowId === rowId ? ' et-row-highlighted' : ''}`}
                        >
                          <td><span className="kind-chip kind-idle_trimmed">Idle (trimmed)</span></td>
                          <td className="tabular">{new Date(b.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – {new Date(b.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                          <td className="tabular secondary">{fmtDurationMs(b.durationMs)}</td>
                          <td className="tertiary">—</td>
                          <td className="tertiary">Trimmed via the agent&apos;s idle prompt.</td>
                          <td />
                        </tr>
                      );
                    }
                    // WORK / MEETING / MANUAL
                    const kind = b.kind === 'MANUAL' ? 'manual_approved' : 'tracked';
                    const rowId = `entry-${b.timeEntryId ?? b.startedAt}`;
                    const isMeeting = b.kind === 'MEETING';
                    return (
                      <EntryRow
                        key={rowId}
                        rowId={rowId}
                        highlighted={highlightedRowId === rowId}
                        kind={kind}
                        block={b}
                        tasks={tasks}
                        disabled={!editable}
                        isMeeting={isMeeting}
                        workspaceUsers={workspaceUsers}
                        selfId={me.id}
                        onSave={async (vars) => {
                          await patchEntry.mutateAsync(vars);
                        }}
                        onDeleteManual={
                          kind === 'manual_approved'
                            ? async (id) => {
                                await deleteManualEntry.mutateAsync(id);
                              }
                            : undefined
                        }
                      />
                    );
                  })}

                  {day.recentRejected.map((r) => {
                    const rowId = `rejected-${r.id}`;
                    return (
                      <EntryRow
                        key={rowId}
                        rowId={rowId}
                        highlighted={highlightedRowId === rowId}
                        kind="rejected"
                        rejected={r}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}

function parseSearchEpochMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function SingleDatePicker({
  date,
  today,
  onChange,
  onPrev,
  onNext,
  nextDisabled,
}: {
  date: string;
  today: string;
  onChange: (date: string) => void;
  onPrev: () => void;
  onNext: () => void;
  nextDisabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(parseDateKey(date)));
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function openPicker() {
    setVisibleMonth(monthStart(parseDateKey(date)));
    setOpen((v) => !v);
  }

  function chooseDay(day: string) {
    if (compareDateKeys(day, today) > 0) return;
    onChange(day);
    setOpen(false);
  }

  return (
    <div className="myd-date-picker" ref={rootRef}>
      <DateStepper
        value={
          <>
            <CalendarDays size={14} strokeWidth={1.8} aria-hidden />
            <span>{fmtDayLabel(date)}</span>
          </>
        }
        onValueClick={openPicker}
        valueExpanded={open}
        valueLabel={`Choose day, current date ${formatFullDateLabel(date)}`}
        onPrev={onPrev}
        onNext={onNext}
        nextDisabled={nextDisabled}
        prevLabel="Previous day"
        nextLabel="Next day"
      />

      {open && (
        <div className="myd-date-popover" role="dialog" aria-label="Choose edit time date">
          <div className="myd-date-popover-head">
            <IconButton
              size="sm"
              icon={<ChevronLeft size={15} strokeWidth={1.8} />}
              aria-label="Previous month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
            />
            <span className="ui-t-eyebrow">{formatMonthLabel(visibleMonth)}</span>
            <IconButton
              size="sm"
              icon={<ChevronRight size={15} strokeWidth={1.8} />}
              aria-label="Next month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
              disabled={compareDateKeys(localDateKey(monthStart(addMonths(visibleMonth, 1))), localDateKey(monthStart(parseDateKey(today)))) > 0}
            />
          </div>

          <CalendarMonth
            month={visibleMonth}
            today={today}
            selected={date}
            onChoose={chooseDay}
          />
        </div>
      )}
    </div>
  );
}

function CalendarMonth({
  month,
  today,
  selected,
  onChoose,
}: {
  month: Date;
  today: string;
  selected: string;
  onChoose: (day: string) => void;
}) {
  const days = calendarCells(month);
  return (
    <section className="myd-calendar" aria-label={formatMonthLabel(month)}>
      <div className="myd-calendar-weekdays" aria-hidden>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, index) => (
          <span key={`${d}-${index}`}>{d}</span>
        ))}
      </div>
      <div className="myd-calendar-days">
        {days.map((day, index) => {
          if (!day) return <span key={`blank-${index}`} aria-hidden />;
          const disabled = compareDateKeys(day, today) > 0;
          const isSelected = day === selected;
          return (
            <button
              key={day}
              type="button"
              className={[
                'myd-calendar-day',
                isSelected ? ' is-selected' : '',
                day === today ? ' is-today' : '',
              ].join('')}
              disabled={disabled}
              onClick={() => onChoose(day)}
              aria-label={formatFullDateLabel(day)}
              aria-pressed={isSelected}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year!, month! - 1, day!);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function compareDateKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function calendarCells(month: Date): Array<string | null> {
  const start = monthStart(month);
  const firstDay = (start.getDay() + 6) % 7;
  const count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = Array.from({ length: firstDay }, () => null);
  for (let day = 1; day <= count; day += 1) {
    cells.push(localDateKey(new Date(start.getFullYear(), start.getMonth(), day)));
  }
  return cells;
}

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatFullDateLabel(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

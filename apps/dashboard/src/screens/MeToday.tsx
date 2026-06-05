import './metoday.css';
import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { api } from '../lib/api';
import { isManagerOrAbove } from '../lib/auth';
import type { DayInsight, WorkspaceUser } from '../lib/types';
import { fmtDayLabel, todayKey, addDays, fmtDurationMs } from '../lib/format';
import { DayRibbon } from '../components/DayRibbon';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import AppUsagePanel from '../components/AppUsagePanel';
import { EntryRow } from '../components/EntryRow';
import type { TaskOption } from '../components/TaskCombo';
import {
  Page,
  PageHeader,
  Card,
  Stat,
  StatRow,
  Toolbar,
  Select,
  DateStepper,
  Tag,
  Banner,
  SkeletonStat,
  SkeletonTable,
} from '../ui';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
}

/**
 * /me-today — the employee's own day, composed STRICTLY from the shared kit
 * (`src/ui`) so it reads as one product with the other 12 pages. The page file
 * contributes layout only: a `PageHeader` (eyebrow → title → toolbar), a
 * day-stage `Card` hosting the timeline ribbon + heatmap, a flush `StatRow` of
 * day totals, the app-usage panel, and a flush `Card` wrapping the editable
 * timesheet. No bespoke colour / type / border / shadow lives here — those come
 * only from the kit + tokens. The page CSS (`myd-` prefix) is pure LAYOUT.
 *
 * The rich, stateful functional core is PRESERVED byte-for-byte: the
 * shift-bounded DayRibbon, the ActivityHeatmap, AppUsagePanel, and the editable
 * EntryRow timesheet (with TimePopover / TaskCombo / attendee pickers) — every
 * prop, handler, mutation, and piece of state is unchanged. The timesheet keeps
 * the exact 6-column `<table>` contract EntryRow renders into.
 *
 * Self-only writes (mirrors the agent's contract): when the viewer looks at
 * their OWN day, every row is editable; a teammate's day (via the user picker
 * + ?userId= deep-link) is read-only with a banner.
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
  const search = useSearch({ from: '/authed/me-today' });
  const qc = useQueryClient();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const initialDate =
    typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : todayKey();
  const initialUserId = typeof search.userId === 'string' && search.userId.length > 0 ? search.userId : me.id;
  const [date, setDate] = useState<string>(initialDate);
  const [targetUserId, setTargetUserId] = useState<string>(initialUserId);
  const showPicker = isManagerOrAbove(me.role);
  const editable = targetUserId === me.id;

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
    mutationFn: (vars: { requestedStart: number; requestedEnd: number; larkTaskGuid: string | null; reason: string; attendeeIds?: string[] }) => {
      const body: Record<string, unknown> = {
        clientUuid: `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        requestedStart: new Date(vars.requestedStart).toISOString(),
        requestedEnd: new Date(vars.requestedEnd).toISOString(),
        larkTaskGuid: vars.larkTaskGuid,
        reason: vars.reason,
      };
      if (vars.attendeeIds && vars.attendeeIds.length > 0) body.attendeeIds = vars.attendeeIds;
      return api('/v1/time-requests', { method: 'POST', json: body });
    },
    onSuccess: invalidate,
  });

  const patchRequest = useMutation({
    mutationFn: (vars: { id: string; requestedStart: number; requestedEnd: number; larkTaskGuid: string | null; reason: string; attendeeIds?: string[] }) => {
      const body: Record<string, unknown> = {
        requestedStart: new Date(vars.requestedStart).toISOString(),
        requestedEnd: new Date(vars.requestedEnd).toISOString(),
        larkTaskGuid: vars.larkTaskGuid,
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
      ? 'My Day'
      : `${targetUser.name.split(' ')[0]}’s Day`
    : 'Day';

  const day = dayQ.data;

  return (
    <Page>
      <PageHeader
        eyebrow={`${tzLabel} · ${fmtDayLabel(date).toUpperCase()}`}
        title={titleName}
        subtitle={isSelf ? 'Review and edit your timesheet.' : `Viewing ${targetUser?.name}’s day — read-only.`}
        actions={
          <Toolbar>
            {showPicker && usersQ.data && (
              <Select
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
            <DateStepper
              value={isToday ? 'Today' : fmtDayLabel(date)}
              onPrev={() => setDate((d) => addDays(d, -1))}
              onNext={() => setDate((d) => addDays(d, 1))}
              nextDisabled={isToday}
              prevLabel="Previous day"
              nextLabel="Next day"
            />
          </Toolbar>
        }
      />

      {dayQ.isError && (
        <Banner status="danger">Couldn’t load the day: {(dayQ.error as Error).message}</Banner>
      )}

      {dayQ.isLoading && (
        <div className="myd-stack">
          <Card title="Day timeline">
            <SkeletonTable rows={3} />
          </Card>
          <Card variant="flush">
            <StatRow>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </StatRow>
          </Card>
        </div>
      )}

      {day && (
        <div className="myd-stack">
          {/* ---- Day stage: timeline ribbon + activity heatmap ---- */}
          <Card
            title="Day timeline"
            action={
              <div className="myd-legend">
                <Tag status="success" dot>Tracked</Tag>
                <Tag status="info" dot>Meeting</Tag>
                <Tag status="warn" dot>Manual</Tag>
                <Tag status="danger" dot>Pending</Tag>
                <Tag status="neutral" dot>Idle</Tag>
              </div>
            }
          >
            {day.shift && (
              <div className="myd-stage-meta">
                <Tag status="neutral" mono>
                  {day.shift.name} · {day.shift.start}–{day.shift.end}
                </Tag>
                <span className="ui-t-small myd-stage-note">
                  Shift-bounded · click a gap to log time.
                </span>
              </div>
            )}
            {!day.shift && (
              <div className="myd-stage-meta">
                <span className="ui-t-small myd-stage-note">Full day · click a gap to log time.</span>
              </div>
            )}

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
                  Viewing {targetUser?.name}’s day — each person edits their own time.
                </Banner>
              </div>
            )}
          </Card>

          {/* ---- Day totals: one flush StatRow keyed to meaning ---- */}
          <Card variant="flush">
            <StatRow>
              <Stat label="Tracked" value={fmtDurationMs(day.totals.workedMs)} />
              <Stat label="Meeting" value={fmtDurationMs(day.totals.meetingMs)} />
              <Stat label="Manual" value={fmtDurationMs(day.totals.manualMs)} />
              <Stat label="Pending" value={fmtDurationMs(day.totals.pendingMs)} />
              <Stat label="Gap" value={fmtDurationMs(day.totals.gapMs)} />
            </StatRow>
          </Card>

          <AppUsagePanel appUsage={day.appUsage} />

          {/* ---- Timesheet: flush Card hosting the exact 6-col EntryRow table ---- */}
          <Card variant="flush">
            <div className="myd-sheet-head">
              <div className="myd-sheet-titling">
                <h2 className="ui-t-title">Timesheet</h2>
                <span className="ui-t-eyebrow">{day.blocks.length} entries</span>
              </div>
              <div className="myd-sheet-totals">
                <Tag status="success" mono>{fmtDurationMs(day.totals.workedMs)} tracked</Tag>
                {day.totals.meetingMs > 0 && (
                  <Tag status="info" mono>{fmtDurationMs(day.totals.meetingMs)} meeting</Tag>
                )}
                {day.totals.manualMs > 0 && (
                  <Tag status="warn" mono>{fmtDurationMs(day.totals.manualMs)} manual</Tag>
                )}
              </div>
            </div>

            <div className="myd-table-wrap">
              <table className="myd-table">
                <thead>
                  <tr>
                    <th className="ui-t-eyebrow" style={{ width: 100 }}>Kind</th>
                    <th className="ui-t-eyebrow" style={{ width: 200 }}>Time</th>
                    <th className="ui-t-eyebrow" style={{ width: 80 }}>Duration</th>
                    <th className="ui-t-eyebrow" style={{ width: 220 }}>Task</th>
                    <th className="ui-t-eyebrow">Notes / Reason</th>
                    <th className="ui-t-eyebrow" style={{ width: 240 }} />
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
                      />
                    );
                  })}

                  {day.recentRejected.map((r) => (
                    <EntryRow key={`rejected-${r.id}`} kind="rejected" rejected={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}

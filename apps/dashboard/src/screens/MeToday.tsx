import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { api } from '../lib/api';
import { isManagerOrAbove } from '../lib/auth';
import type { DayInsight, WorkspaceUser } from '../lib/types';
import { fmtDayLabel, todayKey, addDays, fmtDurationMs } from '../lib/format';
import { DayRibbon } from '../components/DayRibbon';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import AppUsagePanel from '../components/AppUsagePanel';
import { EntryRow } from '../components/EntryRow';
import type { TaskOption } from '../components/TaskCombo';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
}

/**
 * /me-today — the dashboard's edit-time surface. Self-only writes (mirrors
 * the agent's contract): when the viewer is looking at their OWN day, every
 * row is editable; when they're looking at a teammate's day (via the user
 * picker + ?userId= deep-link), the rows are read-only and a banner makes
 * that clear.
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

  function onRibbonClick(epochMs: number) {
    if (!editable || !dayQ.data) return;
    const gap = dayQ.data.blocks.find(
      (b) => b.kind === 'GAP' && epochMs >= b.startedAt && epochMs < b.endedAt,
    );
    if (!gap) return;
    // Slice: a 1h window centered on the click, clamped to the gap edges.
    const slice = Math.min(60 * 60_000, gap.endedAt - gap.startedAt);
    let start = Math.round(epochMs - slice / 2);
    let end = start + slice;
    if (start < gap.startedAt) {
      start = gap.startedAt;
      end = Math.min(gap.endedAt, start + slice);
    }
    if (end > gap.endedAt) {
      end = gap.endedAt;
      start = Math.max(gap.startedAt, end - slice);
    }
    setGapPreset({
      blockKey: `${gap.startedAt}-${gap.endedAt}`,
      range: { startedAt: start, endedAt: end },
      tick: (gapPreset?.tick ?? 0) + 1,
    });
  }

  // Bar↔row link: when the ribbon hovers a block, highlight the matching
  // table row. Uses a single piece of state so only one row can be lit at
  // a time. Row keys match the ribbon's: `entry-<id>`, `pending-<id>`.
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);

  // ---- Derived view state ---------------------------------------------------

  const targetUser: AdminUser | undefined = useMemo(() => {
    if (targetUserId === me.id) return { id: me.id, name: me.name, email: me.email, role: me.role };
    return usersQ.data?.users.find((u) => u.id === targetUserId);
  }, [targetUserId, usersQ.data, me]);

  const now = Date.now();
  const tasks = tasksQ.data?.tasks ?? [];

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1">
            {targetUser ? (targetUser.id === me.id ? 'My Day' : `${targetUser.name.split(' ')[0]}'s Day`) : 'Day'}
          </h1>
          <p className="secondary page-sub">
            {fmtDayLabel(date)} · <span className="tabular">{date}</span> · {tz}
          </p>
        </div>

        <div className="day-controls">
          {showPicker && usersQ.data && (
            <select
              className="select"
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
            </select>
          )}

          <div className="date-nav">
            <button type="button" className="btn-icon" onClick={() => setDate((d) => addDays(d, -1))} aria-label="Previous day">
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`btn-ghost date-pill${date === todayKey() ? ' is-today' : ''}`}
              onClick={() => setDate(todayKey())}
            >
              <Calendar size={13} strokeWidth={1.8} />
              <span>{date === todayKey() ? 'Today' : fmtDayLabel(date)}</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setDate((d) => addDays(d, 1))}
              aria-label="Next day"
              disabled={date === todayKey()}
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </header>

      {dayQ.isLoading && <div className="card empty">Loading…</div>}
      {dayQ.isError && (
        <div className="card empty empty-error">Couldn&apos;t load: {(dayQ.error as Error).message}</div>
      )}

      {dayQ.data && (
        <>
          <section className="card ribbon-card">
            <DayRibbon
              day={dayQ.data}
              now={now}
              onClickEpoch={editable ? onRibbonClick : undefined}
              onHoverRowId={setHighlightedRowId}
            />
            {dayQ.data.activity && dayQ.data.activity.buckets.length > 0 && (
              <ActivityHeatmap day={dayQ.data} heatmap={dayQ.data.activity} />
            )}
            <div className="ribbon-legend">
              <Legend className="dot-work" label="Tracked" />
              <Legend className="dot-meeting" label="Meeting" />
              <Legend className="dot-manual" label="Manual" />
              <Legend className="dot-pending" label="Pending" />
              <Legend className="dot-idle" label="Idle (trimmed)" />
            </div>
            {!editable && (
              <div className="et-readonly-banner">
                Viewing {targetUser?.name}&apos;s day — read-only. Each person edits their own time.
              </div>
            )}
          </section>

          <AppUsagePanel appUsage={dayQ.data.appUsage} />

          <section className="card entries-card" style={{ padding: 0 }}>
            <header className="entries-head">
              <h2 className="h3">Timesheet</h2>
              <div className="entries-totals secondary">
                {fmtDurationMs(dayQ.data.totals.workedMs)} tracked
                {dayQ.data.totals.meetingMs > 0 && <> · {fmtDurationMs(dayQ.data.totals.meetingMs)} meeting</>}
                {dayQ.data.totals.manualMs > 0 && <> · {fmtDurationMs(dayQ.data.totals.manualMs)} manual</>}
              </div>
            </header>

            <table className="entries-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Kind</th>
                  <th style={{ width: 200 }}>Time</th>
                  <th style={{ width: 80 }}>Duration</th>
                  <th style={{ width: 220 }}>Task</th>
                  <th>Notes / Reason</th>
                  <th style={{ width: 240 }} />
                </tr>
              </thead>
              <tbody>
                {dayQ.data.blocks.map((b, i) => {
                  if (b.kind === 'GAP') {
                    const blockKey = `${b.startedAt}-${b.endedAt}`;
                    return (
                      <EntryRow
                        key={`gap-${blockKey}`}
                        kind="gap"
                        block={b}
                        tasks={tasks}
                        disabled={!editable}
                        workspaceUsers={workspaceUsers}
                        selfId={me.id}
                        preset={
                          gapPreset && gapPreset.blockKey === blockKey
                            ? gapPreset.range
                            : undefined
                        }
                        presetTick={
                          gapPreset && gapPreset.blockKey === blockKey ? gapPreset.tick : 0
                        }
                        onCreate={async (vars) => {
                          await createRequest.mutateAsync(vars);
                        }}
                      />
                    );
                  }
                  if (b.kind === 'IDLE_TRIMMED') {
                    return (
                      <tr key={`idle-${i}`} className="et-row entry-row-idle_trimmed">
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
                  const rowId = `entry-${b.timeEntryId ?? `${b.startedAt}-${i}`}`;
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

                {dayQ.data.pendingOverlay.map((p) => {
                  const rowId = `pending-${p.id}`;
                  return (
                    <EntryRow
                      key={rowId}
                      rowId={rowId}
                      highlighted={highlightedRowId === rowId}
                      kind="pending"
                      pending={p}
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
                })}

                {dayQ.data.recentRejected.map((r) => (
                  <EntryRow key={`rejected-${r.id}`} kind="rejected" rejected={r} />
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`legend-dot ${className}`} />
      <span className="callout secondary">{label}</span>
    </span>
  );
}

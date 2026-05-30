import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X, CalendarRange } from 'lucide-react';
import type { DayInsight } from '../lib/agent.d';
import DayRibbon from '../components/DayRibbon';
import EntryRow from '../components/EntryRow';
import type { ManualTimePreset } from '../components/ManualTimeComposer';

/**
 * Edit Time tab — the Time-Doctor-style per-day timesheet.
 *
 * The page shows: a date stepper, a legend, a wide DayRibbon (atomic blocks
 * by kind), and a table where EVERY block in the day is its own inline-
 * editable row. Tracked rows let you re-attribute the task + add notes;
 * pending rows let you change everything; gap rows act as the new-request
 * composer; rejected rows let you re-request.
 *
 * Click a ribbon block → the matching table row scrolls into view + flashes.
 * Click a ribbon gap → the gap row is focused (the row's reason input gets
 * keyboard focus so the user can immediately type why they want the time).
 */

function localToday(): string {
  return new Date().toLocaleDateString('sv-SE');
}
function tz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}
function shiftDate(ymd: string, deltaDays: number): string {
  const { y, m, d } = parseYmd(ymd);
  return new Date(y, m - 1, d + deltaDays).toLocaleDateString('sv-SE');
}
function prettyDate(ymd: string): string {
  const { y, m, d } = parseYmd(ymd);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function EditTime() {
  const [date, setDate] = useState<string>(localToday());
  const [now, setNow] = useState<number>(Date.now());
  const [flashRowId, setFlashRowId] = useState<string | null>(null);
  /**
   * When the user clicks a gap on the ribbon, this is the snapped 1h (or
   * snap-to-full-gap) sub-range. We pass it to the matching gap row in the
   * table so its time inputs reseed to the narrow range and the reason
   * input auto-focuses.
   */
  const [gapPreset, setGapPreset] = useState<ManualTimePreset | null>(null);
  const timezone = useMemo(tz, []);
  const dayQueryKey = useMemo(() => ['dayInsight', date, timezone] as const, [date, timezone]);

  const day = useQuery({
    queryKey: dayQueryKey,
    queryFn: () => window.agent.insights.day({ date, tz: timezone }),
    refetchInterval: date === localToday() ? 5_000 : 60_000,
    retry: 1,
  });
  const larkTasks = useQuery({
    queryKey: ['larkTasks'],
    queryFn: () => window.agent.lark.tasks(),
    refetchInterval: 60_000,
  });
  const tasks = useMemo(() => (larkTasks.data?.tasks ?? []).filter((t) => !t.completed).map((t) => ({ guid: t.guid, summary: t.summary })), [larkTasks.data]);

  useEffect(() => {
    if (date !== localToday()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [date]);

  // Flash dismiss after the CSS animation finishes (1.6s).
  useEffect(() => {
    if (!flashRowId) return;
    const id = setTimeout(() => setFlashRowId(null), 1700);
    return () => clearTimeout(id);
  }, [flashRowId]);

  const onPickPreset = useCallback((preset: ManualTimePreset) => {
    // The preset is a SUB-range of some gap block in the table. We can't
    // match by id (the gap row's id is the GAP's startedAt, not the snapped
    // click). EditTime stores the preset itself; DayBlocksTable below finds
    // the GAP block containing the preset's center and passes presetOverride
    // to that row so its inputs reseed + reason auto-focuses + the row flashes.
    setGapPreset(preset);
  }, []);

  const taskNameFor = useCallback(
    (guid: string | null | undefined) => tasks.find((t) => t.guid === guid)?.summary ?? null,
    [tasks],
  );

  const isToday = date === localToday();
  const dayData = day.data;

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Edit Time</span>
        <div className="et-datebar no-drag">
          <button className="btn-icon" onClick={() => setDate((d) => shiftDate(d, -1))} title="Previous day">
            <ChevronLeft size={16} strokeWidth={2.5} />
          </button>
          <span className="et-date">{prettyDate(date)}</span>
          <button className="btn-icon" onClick={() => setDate((d) => shiftDate(d, 1))} title="Next day" disabled={isToday}>
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
          {!isToday && (
            <button className="btn btn-soft" onClick={() => setDate(localToday())}>Today</button>
          )}
        </div>
      </div>

      <div className="content-scroll">
        <div className="content-narrow">
          {/* Legend */}
          <div className="dt-legend" style={{ justifyContent: 'flex-start', margin: '4px 0 var(--sp-3)' }}>
            <span><i className="dt-dot" style={{ background: 'var(--c-green)' }} /> Work</span>
            <span><i className="dt-dot" style={{ background: 'var(--c-amber)' }} /> Manual</span>
            <span><i className="dt-dot" style={{ background: 'var(--c-blue)' }} /> Meeting</span>
            <span><i className="dt-dot" style={{ background: 'var(--c-slate)' }} /> Break</span>
            <span style={{ color: 'var(--label-tertiary)' }}>· Click a gap to add manual time</span>
          </div>

          {/* Ribbon */}
          {day.isError ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'rgba(255,77,106,0.12)', color: 'var(--danger)' }}>
                <X size={26} strokeWidth={2} />
              </span>
              <div className="h3">Couldn't load this day</div>
              <div className="callout secondary">
                {String((day.error as Error)?.message ?? day.error).includes('timeout')
                  ? "The agent's main process may need a restart (Cmd-Q + relaunch). In dev, HMR only updates the UI; IPC handlers ship in the main process."
                  : 'Check that the API is running on port 4000.'}
              </div>
              <button className="btn btn-prominent no-drag" style={{ marginTop: 'var(--sp-4)' }} onClick={() => day.refetch()}>
                Retry
              </button>
            </div>
          ) : day.isLoading || !dayData ? (
            <div className="focus-card rise rise-1" style={{ height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--label-tertiary)' }}>
              Loading…
            </div>
          ) : dayData.isFuture ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--c-slate-bg)', color: 'var(--c-slate)' }}>
                <CalendarRange size={26} strokeWidth={2} />
              </span>
              <div className="h3">That day hasn't happened yet</div>
              <div className="callout secondary">You can't request manual time for the future.</div>
            </div>
          ) : (
            <div className="focus-card rise rise-1">
              <DayRibbon day={dayData} now={now} taskNameFor={taskNameFor} onPickPreset={onPickPreset} />
            </div>
          )}

          {/* All entries — inline-editable rows */}
          {dayData && (
            <>
              <div className="section-head"><span className="section-title">All entries</span></div>
              <DayBlocksTable
                day={dayData}
                tasks={tasks}
                dayQueryKey={dayQueryKey}
                flashRowId={flashRowId}
                onSelectRow={setFlashRowId}
                gapPreset={gapPreset}
                onClearGapPreset={() => setGapPreset(null)}
              />

              {/* Totals strip */}
              {dayData.blocks.length > 0 && (
                <div className="et-totals rise">
                  <span className="et-total">Work <strong>{fmtDur(dayData.totals.workedMs)}</strong></span>
                  <span className="et-total">Manual <strong>{fmtDur(dayData.totals.manualMs)}</strong></span>
                  <span className="et-total">Meeting <strong>{fmtDur(dayData.totals.meetingMs)}</strong></span>
                  <span className="et-total">Break <strong>{fmtDur(dayData.totals.idleTrimmedMs)}</strong></span>
                  <span className="et-total" style={{ color: 'var(--label-tertiary)' }}>Gap <strong>{fmtDur(dayData.totals.gapMs)}</strong></span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function DayBlocksTable({
  day,
  tasks,
  dayQueryKey,
  flashRowId,
  onSelectRow,
  gapPreset,
  onClearGapPreset,
}: {
  day: DayInsight;
  tasks: Array<{ guid: string; summary: string }>;
  dayQueryKey: readonly unknown[];
  flashRowId: string | null;
  onSelectRow: (rowId: string) => void;
  gapPreset: ManualTimePreset | null;
  onClearGapPreset: () => void;
}) {
  // Which gap block (by index) does the preset's center sit inside? Compute
  // once per render so multiple gap rows don't all reseed.
  const presetGapIdx = useMemo(() => {
    if (!gapPreset) return -1;
    const center = (gapPreset.startedAt + gapPreset.endedAt) / 2;
    return day.blocks.findIndex((b) => b.kind === 'GAP' && b.startedAt <= center && center < b.endedAt);
  }, [day.blocks, gapPreset]);
  // Once we render, clear the gap preset so subsequent renders don't keep
  // forcing the override (the user can now edit the row freely).
  useEffect(() => {
    if (presetGapIdx === -1 || !gapPreset) return;
    // schedule clear AFTER the row has mounted with the preset
    const t = setTimeout(onClearGapPreset, 50);
    return () => clearTimeout(t);
  }, [presetGapIdx, gapPreset, onClearGapPreset]);
  if (day.blocks.length === 0 && day.pendingOverlay.length === 0 && day.recentRejected.length === 0) {
    return (
      <div className="empty rise rise-1">
        <span className="empty-icon" style={{ background: 'var(--c-slate-bg)', color: 'var(--c-slate)' }}>
          <CalendarRange size={26} strokeWidth={2} />
        </span>
        <div className="h3">Quiet day</div>
        <div className="callout secondary">Nothing tracked. Click an empty area in the ribbon above (once there is one) to add manual time.</div>
      </div>
    );
  }
  return (
    <table className="et-table rise">
      <thead>
        <tr>
          <th>Started</th>
          <th>Ended</th>
          <th>Total</th>
          <th>Task</th>
          <th>Reason / Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {day.blocks.map((b, i) => {
          if (b.kind === 'GAP') {
            const rowId = `gap-${b.startedAt}`;
            const isPresetTarget = i === presetGapIdx && !!gapPreset;
            return (
              <EntryRow
                key={rowId}
                kind="gap"
                rowId={rowId}
                flashing={flashRowId === rowId || isPresetTarget}
                startedAt={b.startedAt}
                endedAt={b.endedAt}
                larkTaskGuid={null}
                notes={null}
                tasks={tasks}
                dayQueryKey={dayQueryKey}
                onSelectRow={onSelectRow}
                presetOverride={isPresetTarget && gapPreset ? { startedAt: gapPreset.startedAt, endedAt: gapPreset.endedAt } : null}
              />
            );
          }
          // Tracked AUTO + MANUAL (APPROVED) + MEETING + IDLE_TRIMMED all flow through tracked.
          const isManual = b.kind === 'MANUAL';
          const rowId = `entry-${b.timeEntryId}-${i}`;
          return (
            <EntryRow
              key={rowId}
              kind={isManual ? 'manual_approved' : 'tracked'}
              rowId={rowId}
              flashing={flashRowId === rowId}
              startedAt={b.startedAt}
              endedAt={b.endedAt}
              isOpen={b.isOpen}
              refId={b.timeEntryId}
              larkTaskGuid={b.larkTaskGuid ?? null}
              notes={b.notes ?? null}
              tasks={tasks}
              dayQueryKey={dayQueryKey}
              onSelectRow={onSelectRow}
            />
          );
        })}
        {/* PENDING requests live in their own pendingOverlay array (they're not blocks because they haven't created a TimeEntry yet). */}
        {day.pendingOverlay.map((p) => {
          const rowId = `pending-${p.id}`;
          return (
            <EntryRow
              key={rowId}
              kind="pending"
              rowId={rowId}
              flashing={flashRowId === rowId}
              startedAt={p.startedAt}
              endedAt={p.endedAt}
              refId={p.id}
              larkTaskGuid={p.larkTaskGuid}
              notes={p.reason}
              tasks={tasks}
              dayQueryKey={dayQueryKey}
              onSelectRow={onSelectRow}
            />
          );
        })}
        {/* REJECTED requests for context + re-request. */}
        {day.recentRejected.map((r) => {
          const rowId = `rejected-${r.id}`;
          return (
            <EntryRow
              key={rowId}
              kind="rejected"
              rowId={rowId}
              flashing={flashRowId === rowId}
              startedAt={r.requestedStart}
              endedAt={r.requestedEnd}
              refId={r.id}
              larkTaskGuid={r.larkTaskGuid}
              notes={r.reason}
              decidedReason={r.decidedReason}
              tasks={tasks}
              dayQueryKey={dayQueryKey}
              onSelectRow={onSelectRow}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

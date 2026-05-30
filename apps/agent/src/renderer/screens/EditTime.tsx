import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
function prettyDateParts(ymd: string): { dow: string; rest: string } {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(y, m - 1, d);
  return {
    dow: dt.toLocaleDateString(undefined, { weekday: 'short' }),
    rest: dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

export default function EditTime() {
  const [date, setDate] = useState<string>(localToday());
  const [now, setNow] = useState<number>(Date.now());
  const [flashRowId, setFlashRowId] = useState<string | null>(null);
  /** Mirror of "which ribbon block is the user hovering right now?" so the
   *  matching table row can render a subtle shadow + connect the two
   *  surfaces visually. Cleared on mouseleave. */
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  /**
   * Latest ribbon-click snap range + a monotonic `tick` so that clicking
   * the same spot twice still re-applies (EntryRow's effect keys on tick).
   * Never cleared automatically — once the user starts editing, their
   * subsequent edits live in the row's own draft state and survive.
   */
  const [gapPreset, setGapPreset] = useState<(ManualTimePreset & { tick: number }) | null>(null);
  const timezone = useMemo(tz, []);
  const dayQueryKey = useMemo(() => ['dayInsight', date, timezone] as const, [date, timezone]);

  const day = useQuery({
    queryKey: dayQueryKey,
    queryFn: () => window.agent.insights.day({ date, tz: timezone }),
    // Polling caused visible churn (today's trailing-gap endedAt = now tick
    // every poll). Drop it. Mutations invalidate this key explicitly, and
    // window-focus refetch covers "I just got back from Lark".
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
  });
  const larkTasks = useQuery({
    queryKey: ['larkTasks'],
    queryFn: () => window.agent.lark.tasks(),
    refetchInterval: 60_000,
  });
  const tasks = useMemo(() => (larkTasks.data?.tasks ?? []).filter((t) => !t.completed).map((t) => ({ guid: t.guid, summary: t.summary })), [larkTasks.data]);

  /**
   * If the day has no tracked blocks, synthesize gap blocks across the
   * working window (9 AM → min(9 PM, now)) so the user can still click the
   * whole bar to add manual time. Pending overlays subtract from the
   * synthesized window — so submitting a 2h range leaves two gaps (before
   * + after) plus the red pending row in between.
   */
  const effectiveDay = useMemo(() => {
    if (!day.data) return null;
    const d = day.data;
    if (d.isFuture || d.blocks.length > 0) return d;
    const HOUR = 60 * 60 * 1000;
    const start = d.dayStart + 9 * HOUR;
    const endCap = d.isToday ? Date.now() : d.dayEnd;
    const end = Math.min(start + 12 * HOUR, endCap);
    if (end <= start + 5 * 60 * 1000) return d; // window too narrow (e.g. early morning today)
    // Build gaps = [start, end] minus all pendingOverlay ranges.
    const sorted = [...d.pendingOverlay].sort((a, b) => a.startedAt - b.startedAt);
    const blocks: typeof d.blocks = [];
    let cursor = start;
    for (const p of sorted) {
      const pStart = Math.max(p.startedAt, start);
      const pEnd = Math.min(p.endedAt, end);
      if (pStart >= end) break;
      if (pStart > cursor) {
        blocks.push({ kind: 'GAP', startedAt: cursor, endedAt: pStart, durationMs: pStart - cursor });
      }
      cursor = Math.max(cursor, pEnd);
    }
    if (cursor < end) {
      blocks.push({ kind: 'GAP', startedAt: cursor, endedAt: end, durationMs: end - cursor });
    }
    return {
      ...d,
      blocks,
      firstActivityAt: start,
      lastActivityAt: end,
    };
  }, [day.data]);

  // Slow "now" ticking — the ribbon's "now" cursor and the trailing-gap
  // visualization only need minute resolution. 1s caused full ribbon
  // re-renders 60×/min for no perceptible benefit.
  useEffect(() => {
    if (date !== localToday()) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [date]);

  // Keyboard shortcuts: [ prev day, ] next day, T today. Only when no input
  // is focused (don't steal the user's typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '[') { e.preventDefault(); setDate((d) => shiftDate(d, -1)); }
      else if (e.key === ']') { if (date !== localToday()) { e.preventDefault(); setDate((d) => shiftDate(d, 1)); } }
      else if (e.key.toLowerCase() === 't') { e.preventDefault(); setDate(localToday()); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [date]);

  // Flash dismiss after the CSS animation finishes (1.6s).
  useEffect(() => {
    if (!flashRowId) return;
    const id = setTimeout(() => setFlashRowId(null), 1700);
    return () => clearTimeout(id);
  }, [flashRowId]);

  const onPickPreset = useCallback((preset: ManualTimePreset) => {
    // Bump the tick so even re-clicking the exact same spot re-applies the
    // preset (otherwise React's effect bails on value-equal deps).
    setGapPreset((prev) => ({ ...preset, tick: (prev?.tick ?? 0) + 1 }));
  }, []);

  const taskNameFor = useCallback(
    (guid: string | null | undefined) => tasks.find((t) => t.guid === guid)?.summary ?? null,
    [tasks],
  );

  const isToday = date === localToday();
  const dayData = effectiveDay ?? day.data;

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Edit Time</span>
        <div className="et-datebar no-drag">
          <button className="btn-icon" onClick={() => setDate((d) => shiftDate(d, -1))} title="Previous day ( [ )" aria-label="Previous day">
            <ChevronLeft size={16} strokeWidth={2.5} />
          </button>
          <span className="et-date">
            <span className="et-date-dow">{prettyDateParts(date).dow}</span>
            {prettyDateParts(date).rest}
          </span>
          <button className="btn-icon" onClick={() => setDate((d) => shiftDate(d, 1))} title="Next day ( ] )" aria-label="Next day" disabled={isToday}>
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
          {!isToday && (
            <button className="btn btn-soft" onClick={() => setDate(localToday())} title="Today ( T )">Today</button>
          )}
          <span className="et-kbd-hint">
            <span className="et-kbd">[</span> / <span className="et-kbd">]</span> / <span className="et-kbd">T</span>
          </span>
        </div>
      </div>

      <div className="content-scroll">
        <div className="content-narrow">
          {/* Legend — only the states the user actually creates: tracked /
              manual / pending. Meetings + breaks aren't first-class in v3. */}
          <div className="dt-legend" style={{ justifyContent: 'flex-start', margin: '4px 0 var(--sp-3)' }}>
            <span><i className="dt-dot" style={{ background: 'var(--c-green)' }} /> Working</span>
            <span><i className="dt-dot" style={{ background: 'var(--c-amber)' }} /> Manual</span>
            <span><i className="dt-dot" style={{ background: 'var(--danger)' }} /> Pending approval</span>
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
            <div className="et-ribbon-wrap rise rise-1">
              <DayRibbon
                day={dayData}
                now={now}
                taskNameFor={taskNameFor}
                onPickPreset={onPickPreset}
                onHoverBlock={setHoveredRowId}
              />
            </div>
          )}

          {/* Inline-editable rows. The table sits in its own card directly
              under the ribbon so the two surfaces feel like one connected
              timeline view (no extra section heading needed). */}
          {dayData && (
            <>
              <DayBlocksTable
                day={dayData}
                tasks={tasks}
                dayQueryKey={dayQueryKey}
                flashRowId={flashRowId}
                onSelectRow={setFlashRowId}
                gapPreset={gapPreset}
                hoveredRowId={hoveredRowId}
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
  hoveredRowId,
}: {
  day: DayInsight;
  tasks: Array<{ guid: string; summary: string }>;
  dayQueryKey: readonly unknown[];
  flashRowId: string | null;
  onSelectRow: (rowId: string) => void;
  gapPreset: (ManualTimePreset & { tick: number }) | null;
  hoveredRowId: string | null;
}) {
  // Which gap block (by index) does the preset's center sit inside? Routed
  // once per ribbon click; the EntryRow itself only re-applies on tick
  // change, so a stale preset doesn't keep snapping the row back when the
  // user manually edits start/end.
  const presetGapIdx = useMemo(() => {
    if (!gapPreset) return -1;
    const center = (gapPreset.startedAt + gapPreset.endedAt) / 2;
    return day.blocks.findIndex((b) => b.kind === 'GAP' && b.startedAt <= center && center < b.endedAt);
  }, [day.blocks, gapPreset]);
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
    <div className="et-table-wrap rise">
    <table className="et-table">
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
        {(() => {
          // Build a single, time-sorted list of rows so pending requests
          // appear in-place chronologically rather than dumped at the bottom.
          type Row =
            | { sortKey: number; kind: 'tracked' | 'manual_approved'; key: string; node: ReactNode }
            | { sortKey: number; kind: 'pending'; key: string; node: ReactNode }
            | { sortKey: number; kind: 'gap'; key: string; node: ReactNode };
          const rows: Row[] = [];

          day.blocks.forEach((b, i) => {
            if (b.kind === 'GAP') {
              // Hide gap rows entirely covered by a pending overlay (the
              // pending row IS that time, so showing both would duplicate).
              const fullyPending = day.pendingOverlay.some(
                (p) => p.startedAt <= b.startedAt && p.endedAt >= b.endedAt,
              );
              if (fullyPending) return;
              const rowId = `gap-${b.startedAt}`;
              const isPresetTarget = i === presetGapIdx && !!gapPreset;
              rows.push({
                sortKey: b.startedAt,
                kind: 'gap',
                key: rowId,
                node: (
                  <EntryRow
                    key={rowId}
                    kind="gap"
                    rowId={rowId}
                    flashing={flashRowId === rowId || isPresetTarget}
                    highlighted={hoveredRowId === rowId}
                    startedAt={b.startedAt}
                    endedAt={b.endedAt}
                    larkTaskGuid={null}
                    notes={null}
                    tasks={tasks}
                    dayQueryKey={dayQueryKey}
                    onSelectRow={onSelectRow}
                    presetOverride={isPresetTarget && gapPreset ? { startedAt: gapPreset.startedAt, endedAt: gapPreset.endedAt, tick: gapPreset.tick } : null}
                  />
                ),
              });
              return;
            }
            const isManual = b.kind === 'MANUAL';
            const rowId = `entry-${b.timeEntryId}-${i}`;
            rows.push({
              sortKey: b.startedAt,
              kind: isManual ? 'manual_approved' : 'tracked',
              key: rowId,
              node: (
                <EntryRow
                  key={rowId}
                  kind={isManual ? 'manual_approved' : 'tracked'}
                  rowId={rowId}
                  flashing={flashRowId === rowId}
                  highlighted={hoveredRowId === rowId}
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
              ),
            });
          });

          day.pendingOverlay.forEach((p) => {
            const rowId = `pending-${p.id}`;
            rows.push({
              sortKey: p.startedAt,
              kind: 'pending',
              key: rowId,
              node: (
                <EntryRow
                  key={rowId}
                  kind="pending"
                  rowId={rowId}
                  flashing={flashRowId === rowId}
                  highlighted={hoveredRowId === rowId}
                  startedAt={p.startedAt}
                  endedAt={p.endedAt}
                  refId={p.id}
                  larkTaskGuid={p.larkTaskGuid}
                  notes={p.reason}
                  tasks={tasks}
                  dayQueryKey={dayQueryKey}
                  onSelectRow={onSelectRow}
                />
              ),
            });
          });

          // Time-sorted. Stable on equal startedAt because Array.sort is
          // stable in modern JS and rows.forEach preserved insertion order.
          rows.sort((a, b) => a.sortKey - b.sortKey);
          return rows.map((r) => r.node);
        })()}
        {/* Rejected requests are intentionally NOT rendered — they go back to
            "white" (a clean gap the user can re-request from). The decision
            + reason still live on the request in DB + in Lark IM history. */}
      </tbody>
    </table>
    </div>
  );
}

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

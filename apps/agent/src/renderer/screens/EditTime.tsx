import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ClockArrowUp, Plus, X, CalendarRange } from 'lucide-react';
import type { DayInsight } from '../lib/agent.d';
import DayRibbon from '../components/DayRibbon';
import ManualTimeComposer, { type ManualTimePreset } from '../components/ManualTimeComposer';

/**
 * Edit Time tab — per-day timesheet with click-to-fill manual-time gaps.
 *
 * Top: date stepper (◀ ▶ + Today).
 * Middle: legend → DayRibbon → optional composer.
 * Bottom: DayBlocksTable of every block + totals strip.
 */

function localToday(): string {
  // YYYY-MM-DD in local TZ. Using `sv-SE` locale (Swedish) is the standard
  // hack to get ISO-format-but-local-date.
  return new Date().toLocaleDateString('sv-SE');
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
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
  const qc = useQueryClient();
  const [date, setDate] = useState<string>(localToday());
  const [now, setNow] = useState<number>(Date.now());
  const [preset, setPreset] = useState<ManualTimePreset | null>(null);
  const [showComposer, setShowComposer] = useState<boolean>(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const timezone = useMemo(tz, []);

  const day = useQuery({
    queryKey: ['dayInsight', date, timezone],
    queryFn: () => window.agent.insights.day({ date, tz: timezone }),
    refetchInterval: date === localToday() ? 5_000 : 60_000,
  });
  const larkTasks = useQuery({
    queryKey: ['larkTasks'],
    queryFn: () => window.agent.lark.tasks(),
    refetchInterval: 60_000,
  });

  // 1s tick on today only, so live blocks (running entry, trailing gap) feel alive.
  useEffect(() => {
    if (date !== localToday()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [date]);

  const tasks = larkTasks.data?.tasks ?? [];
  const taskNameFor = useCallback(
    (guid: string | null | undefined) => tasks.find((t) => t.guid === guid)?.summary ?? null,
    [tasks],
  );

  const onPickPreset = useCallback((p: ManualTimePreset) => {
    setPreset(p);
    setShowComposer(true);
    // Scroll the composer into view on the next paint.
    requestAnimationFrame(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, []);

  const onCreated = useCallback(() => {
    setShowComposer(false);
    setPreset(null);
    void qc.invalidateQueries({ queryKey: ['dayInsight', date, timezone] });
    void qc.invalidateQueries({ queryKey: ['myTimeRequests'] });
  }, [qc, date, timezone]);

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
          <button
            className="btn-icon"
            onClick={() => setDate((d) => shiftDate(d, 1))}
            title="Next day"
            disabled={isToday}
          >
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
          {!isToday && (
            <button className="btn btn-soft" onClick={() => setDate(localToday())}>
              Today
            </button>
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
          {day.isLoading || !dayData ? (
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

          {/* Composer */}
          <div className="section-head" style={{ marginTop: 'var(--sp-5)' }}>
            <span className="section-title">Add manual time</span>
            <button className="btn btn-soft no-drag" onClick={() => { setShowComposer((s) => !s); if (showComposer) setPreset(null); }} disabled={!!dayData?.isFuture}>
              {showComposer ? <><X size={14} strokeWidth={2.5} /> Cancel</> : <><Plus size={14} strokeWidth={2.5} /> New request</>}
            </button>
          </div>
          {showComposer && (
            <div ref={composerRef}>
              <ManualTimeComposer
                larkTasks={tasks.filter((t) => !t.completed).map((t) => ({ guid: t.guid, summary: t.summary }))}
                preset={preset}
                onCreated={onCreated}
              />
            </div>
          )}

          {/* Pending requests for this day */}
          {dayData && dayData.pendingOverlay.length > 0 && (
            <>
              <div className="section-head"><span className="section-title">Pending requests</span></div>
              <div className="task-list">
                {dayData.pendingOverlay.map((p) => (
                  <div key={p.id} className="task-card rise" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
                    <span className="dt-dot" style={{ background: 'var(--c-amber)' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="callout" style={{ fontWeight: 600, display: 'block' }}>
                        {taskNameFor(p.larkTaskGuid) ?? 'Untracked'}
                      </span>
                      <span className="small secondary">
                        {fmtRange(p.startedAt, p.endedAt)} — {p.reason}
                      </span>
                    </span>
                    <span className="et-chip et-chip-manual"><ClockArrowUp size={11} strokeWidth={2.5} /> PENDING</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Day blocks */}
          <div className="section-head"><span className="section-title">All entries</span></div>
          {dayData && <DayBlocksTable day={dayData} taskNameFor={taskNameFor} onAddForGap={onPickPreset} />}

          {/* Totals strip */}
          {dayData && dayData.blocks.length > 0 && (
            <div className="et-totals rise">
              <span className="et-total">Work <strong>{fmtDur(dayData.totals.workedMs)}</strong></span>
              <span className="et-total">Manual <strong>{fmtDur(dayData.totals.manualMs)}</strong></span>
              <span className="et-total">Meeting <strong>{fmtDur(dayData.totals.meetingMs)}</strong></span>
              <span className="et-total">Break <strong>{fmtDur(dayData.totals.idleTrimmedMs)}</strong></span>
              <span className="et-total" style={{ color: 'var(--label-tertiary)' }}>Gap <strong>{fmtDur(dayData.totals.gapMs)}</strong></span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function DayBlocksTable({
  day,
  taskNameFor,
  onAddForGap,
}: {
  day: DayInsight;
  taskNameFor: (guid: string | null | undefined) => string | null;
  onAddForGap: (p: ManualTimePreset) => void;
}) {
  if (day.blocks.length === 0) {
    return (
      <div className="empty rise rise-1">
        <span className="empty-icon" style={{ background: 'var(--c-slate-bg)', color: 'var(--c-slate)' }}>
          <CalendarRange size={26} strokeWidth={2} />
        </span>
        <div className="h3">Quiet day</div>
        <div className="callout secondary">Nothing tracked. Use “New request” above to add manual time.</div>
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
          <th>Type</th>
          <th>Task</th>
          <th>Reason</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {day.blocks.map((b, i) => {
          const cls = b.kind === 'MANUAL' ? 'et-row-manual' : b.kind === 'GAP' ? 'et-row-gap' : '';
          const live = b.isOpen ? ' et-row-live' : '';
          return (
            <tr key={b.timeEntryId ? `${b.timeEntryId}-${i}` : `${b.kind}-${b.startedAt}`} className={cls + live}>
              <td>{fmtTime(b.startedAt)}</td>
              <td>{b.isOpen ? 'now' : fmtTime(b.endedAt)}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtDur(b.durationMs)}</td>
              <td><TypeChip kind={b.kind} /></td>
              <td>{taskNameFor(b.larkTaskGuid) ?? (b.kind === 'GAP' ? '—' : 'Untracked')}</td>
              <td>{b.kind === 'MANUAL' ? '(manual)' : b.kind === 'GAP' ? 'Not working' : ''}</td>
              <td style={{ textAlign: 'right' }}>
                {b.kind === 'GAP' && (
                  <button
                    className="et-fill-link no-drag"
                    onClick={() =>
                      onAddForGap({
                        startedAt: b.startedAt,
                        endedAt: b.endedAt,
                        larkTaskGuid: null,
                      })
                    }
                  >
                    + Add manual time
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TypeChip({ kind }: { kind: DayInsight['blocks'][number]['kind'] }) {
  if (kind === 'WORK') return <span className="et-chip et-chip-work">Work</span>;
  if (kind === 'MEETING') return <span className="et-chip et-chip-meeting">Meeting</span>;
  if (kind === 'MANUAL') return <span className="et-chip et-chip-manual">Manual</span>;
  if (kind === 'IDLE_TRIMMED') return <span className="et-chip et-chip-idle">Break</span>;
  return <span className="et-chip et-chip-gap">Not working</span>;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtRange(a: number, b: number): string {
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}
function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Calendar, Download, Check, Minus } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import type { TimesheetMatrix } from '../lib/types';
import { fmtTime, fmtDurationMs, fmtDayLabel, addDays, todayKey } from '../lib/format';

const SCOPE_LABEL: Record<TimesheetMatrix['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const RANGES: Array<{ key: '7' | '14' | '30'; label: string; days: number }> = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '14', label: 'Last 14 days', days: 14 },
  { key: '30', label: 'Last 30 days', days: 30 },
];

/** A user-day is "present" when they tracked at least PRESENT_MIN_MS. */
const PRESENT_MIN_MS = 30 * 60 * 1000;

/**
 * Attendance grid — same scoped /v1/admin/timesheets data as /team but
 * recast as a calendar: each user row × day shows a present/absent badge
 * plus first/last activity times. Quick scan: "who showed up on Tuesday
 * and when did they actually start?"
 *
 * Export CSV button opens the .csv variant of the endpoint, which respects
 * the same scope + date range and downloads with the cookie session.
 */
export function AttendanceScreen() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const [anchor, setAnchor] = useState<string>(todayKey());
  const [rangeKey, setRangeKey] = useState<'7' | '14' | '30'>('14');
  const days = RANGES.find((r) => r.key === rangeKey)!.days;
  const from = addDays(anchor, -(days - 1));

  const q = useQuery({
    queryKey: ['admin', 'attendance', from, anchor, tz],
    queryFn: () => {
      const params = new URLSearchParams({ from, to: anchor, tz });
      return api<TimesheetMatrix>(`/v1/admin/timesheets?${params.toString()}`);
    },
  });

  function csvUrl(): string {
    const params = new URLSearchParams({ from, to: anchor, tz });
    return `${API_BASE}/v1/admin/timesheets.csv?${params.toString()}`;
  }

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1">Attendance</h1>
          <p className="secondary page-sub">
            {q.data ? <span className="scope-chip">{SCOPE_LABEL[q.data.scope]}</span> : <span>Loading…</span>}
            {q.data && (
              <>
                {' · '}
                <span className="tabular">{fmtDayLabel(q.data.from)} – {fmtDayLabel(q.data.to)}</span>
              </>
            )}
          </p>
        </div>

        <div className="day-controls">
          <a className="btn-ghost btn-with-icon" href={csvUrl()} download>
            <Download size={14} strokeWidth={1.8} />
            <span>Export CSV</span>
          </a>

          <div className="tabs">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`tab${rangeKey === r.key ? ' is-active' : ''}`}
                onClick={() => setRangeKey(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="date-nav">
            <button type="button" className="btn-icon" onClick={() => setAnchor((d) => addDays(d, -days))} aria-label="Previous range">
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`btn-ghost date-pill${anchor === todayKey() ? ' is-today' : ''}`}
              onClick={() => setAnchor(todayKey())}
            >
              <Calendar size={13} strokeWidth={1.8} />
              <span>{anchor === todayKey() ? 'Now' : fmtDayLabel(anchor)}</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setAnchor((d) => addDays(d, days))}
              aria-label="Next range"
              disabled={anchor === todayKey()}
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading…</div>}
      {q.isError && (
        <div className="card empty empty-error">Couldn&apos;t load: {(q.error as Error).message}</div>
      )}

      {q.data && q.data.users.length > 0 && (
        <section className="card timesheet-card" style={{ padding: 0 }}>
          <div className="timesheet-scroll">
            <table className="timesheet attendance">
              <thead>
                <tr>
                  <th className="ts-user-col">Person</th>
                  {q.data.days.map((d) => (
                    <th key={d} className="ts-day-col">
                      <div className="ts-day-head">
                        <span className="ts-day-dow">
                          {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
                            new Date(`${d}T00:00:00`),
                          )}
                        </span>
                        <span className="ts-day-num">
                          {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
                            new Date(`${d}T00:00:00`),
                          )}
                        </span>
                      </div>
                    </th>
                  ))}
                  <th className="ts-total-col">Days present</th>
                </tr>
              </thead>
              <tbody>
                {q.data.users.map((u) => {
                  const row = q.data!.cells[u.id] ?? {};
                  const daysPresent = q.data!.days.filter(
                    (d) => (row[d]?.totalMs ?? 0) >= PRESENT_MIN_MS,
                  ).length;
                  return (
                    <tr key={u.id}>
                      <td className="ts-user-col">
                        <div className="ts-user">
                          <div className="avatar-sm" aria-hidden>
                            {initials(u.name)}
                          </div>
                          <div className="ts-user-meta">
                            <div className="ts-user-name">{u.name}</div>
                            <div className="callout secondary">{u.role.toLowerCase()}</div>
                          </div>
                        </div>
                      </td>
                      {q.data!.days.map((d) => {
                        const cell = row[d];
                        const present = cell ? cell.totalMs >= PRESENT_MIN_MS : false;
                        const first = cell?.firstActivityMs ? fmtTime(cell.firstActivityMs) : null;
                        const last = cell?.lastActivityMs ? fmtTime(cell.lastActivityMs) : null;
                        return (
                          <td key={d} className="ts-day-col">
                            <div className={`att-cell${present ? ' is-present' : ''}`}>
                              {present ? (
                                <>
                                  <div className="att-badge">
                                    <Check size={11} strokeWidth={2.4} />
                                  </div>
                                  <div className="att-times tabular">
                                    {first} – {last}
                                  </div>
                                  <div className="att-total small secondary">
                                    {fmtDurationMs(cell!.totalMs)}
                                  </div>
                                </>
                              ) : (
                                <div className="att-absent" title="No tracked time (or less than 30 min)">
                                  <Minus size={12} strokeWidth={2.2} />
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                      <td className="ts-total-col tabular">
                        {daysPresent} / {q.data!.days.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

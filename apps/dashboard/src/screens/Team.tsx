import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Calendar, Download } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import type { TimesheetMatrix } from '../lib/types';
import { fmtDurationMs, fmtDayLabel, addDays, todayKey } from '../lib/format';

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

/**
 * Team timesheets — Hubstaff-style users × days matrix. Each cell is a
 * heat-coloured pill showing total tracked time; hover reveals the
 * worked / meeting / manual breakdown. Click a cell to drill into that
 * day for that user (via /me-today with ?userId= ?date=).
 *
 * MANAGER+ only. MEMBERs hitting this URL get 403'd at the API.
 */
export function TeamScreen() {
  const navigate = useNavigate();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Anchor = the right-most ("to") day in the window. Defaults to today.
  // Range size + anchor make navigation predictable; full date picker
  // lives behind the "Custom…" affordance (future).
  const [anchor, setAnchor] = useState<string>(todayKey());
  const [rangeKey, setRangeKey] = useState<'7' | '14' | '30'>('7');
  const days = RANGES.find((r) => r.key === rangeKey)!.days;
  const from = addDays(anchor, -(days - 1));

  const q = useQuery({
    queryKey: ['admin', 'timesheets', from, anchor, tz],
    queryFn: () => {
      const params = new URLSearchParams({ from, to: anchor, tz });
      return api<TimesheetMatrix>(`/v1/admin/timesheets?${params.toString()}`);
    },
  });

  const maxTotal = useMemo(() => {
    if (!q.data) return 0;
    let m = 0;
    for (const u of q.data.users) {
      const row = q.data.cells[u.id];
      if (!row) continue;
      for (const day of q.data.days) {
        const c = row[day];
        if (c && c.totalMs > m) m = c.totalMs;
      }
    }
    return m;
  }, [q.data]);

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1">Team</h1>
          <p className="secondary page-sub">
            {q.data ? <span className="scope-chip">{SCOPE_LABEL[q.data.scope]}</span> : <span>Loading…</span>}
            {q.data && (
              <>
                {' · '}
                <span className="tabular">
                  {fmtDayLabel(q.data.from)} – {fmtDayLabel(q.data.to)}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="day-controls">
          <a
            className="btn-ghost btn-with-icon"
            href={`${API_BASE}/v1/admin/timesheets.csv?${new URLSearchParams({ from, to: anchor, tz }).toString()}`}
            download
          >
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
            <button
              type="button"
              className="btn-icon"
              onClick={() => setAnchor((d) => addDays(d, -days))}
              aria-label="Previous range"
            >
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
        <div className="card empty empty-error">
          Couldn&apos;t load: {(q.error as Error).message}
        </div>
      )}

      {q.data && q.data.users.length === 0 && (
        <div className="card empty">No users in scope.</div>
      )}

      {q.data && q.data.users.length > 0 && (
        <section className="card timesheet-card" style={{ padding: 0 }}>
          <div className="timesheet-scroll">
            <table className="timesheet">
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
                  <th className="ts-total-col">Total</th>
                </tr>
              </thead>
              <tbody>
                {q.data.users.map((u) => {
                  const row = q.data!.cells[u.id] ?? {};
                  const rowTotal = q.data!.days.reduce((sum, d) => sum + (row[d]?.totalMs ?? 0), 0);
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
                        const total = cell?.totalMs ?? 0;
                        const intensity = maxTotal > 0 ? Math.min(1, total / maxTotal) : 0;
                        return (
                          <td key={d} className="ts-day-col">
                            <button
                              type="button"
                              className={`ts-cell${total === 0 ? ' is-empty' : ''}`}
                              onClick={() => navigate({ to: '/me-today', search: { date: d, userId: u.id } })}
                              title={
                                cell
                                  ? `${fmtDurationMs(cell.totalMs)} total · ${fmtDurationMs(cell.workedMs)} work · ${fmtDurationMs(cell.meetingMs)} mtg · ${fmtDurationMs(cell.manualMs)} manual`
                                  : 'No tracked time'
                              }
                              style={
                                total > 0
                                  ? {
                                      background: `rgba(33, 193, 122, ${0.08 + intensity * 0.34})`,
                                      borderColor: `rgba(33, 193, 122, ${0.18 + intensity * 0.32})`,
                                    }
                                  : undefined
                              }
                            >
                              <span className="ts-cell-total tabular">
                                {total > 0 ? fmtDurationMs(total) : '—'}
                              </span>
                              {cell && cell.manualMs > 0 && (
                                <span className="ts-cell-marker ts-marker-manual" title="includes manual time" />
                              )}
                            </button>
                          </td>
                        );
                      })}
                      <td className="ts-total-col tabular">{fmtDurationMs(rowTotal)}</td>
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

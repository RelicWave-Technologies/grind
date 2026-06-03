import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Download, FileSpreadsheet } from 'lucide-react';
import { api, API_BASE } from '../lib/api';

/**
 * /payroll — ADMIN monthly payroll worksheet (M15).
 *
 * Picks a month, previews the per-user totals (days present, hours by
 * kind), and downloads a CSV via the /v1/admin/payroll/monthly.csv
 * endpoint. The exact column set is intentionally conservative — we'll
 * iterate after the finance + Vijay sir alignment.
 */

interface PayrollRow {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    teamName: string | null;
  };
  daysPresent: number;
  workedHours: number;
  meetingHours: number;
  manualHours: number;
  totalHours: number;
  avgDayHours: number;
}

interface MonthlyPayroll {
  month: string;
  tz: string;
  generatedAtMs: number;
  rows: PayrollRow[];
  totals: {
    daysPresent: number;
    workedHours: number;
    meetingHours: number;
    manualHours: number;
    totalHours: number;
  };
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

export function PayrollScreen() {
  const [month, setMonth] = useState<string>(thisMonth());
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const q = useQuery({
    queryKey: ['admin', 'payroll', month, tz],
    queryFn: () => api<MonthlyPayroll>(`/v1/admin/payroll/monthly?month=${month}&tz=${tz}`),
  });

  async function downloadCsv() {
    // Cross-origin fetch + Blob so the auth cookie travels and we can
    // suggest a sane filename. Native <a download> wouldn't pick up the
    // Content-Disposition header in a cross-origin context.
    const res = await fetch(`${API_BASE}/v1/admin/payroll/monthly.csv?month=${month}&tz=${tz}`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grind-payroll-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileSpreadsheet size={20} strokeWidth={1.8} /> Payroll worksheet
          </h1>
          <p className="secondary page-sub">
            Monthly hours summary, ready for finance. CSV format will be refined with the accounts team — current
            columns: name, email, role, team, days present, worked / meeting / manual / total / avg-day hours.
          </p>
        </div>

        <div className="day-controls">
          <div className="date-nav">
            <button type="button" className="btn-icon" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
              ‹
            </button>
            <button
              type="button"
              className={`btn-ghost date-pill${month === thisMonth() ? ' is-today' : ''}`}
              onClick={() => setMonth(thisMonth())}
            >
              <Calendar size={13} strokeWidth={1.8} />
              <span>{fmtMonth(month)}</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={month >= thisMonth()}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          <button
            type="button"
            className="btn btn-prominent"
            onClick={downloadCsv}
            disabled={!q.data || q.data.rows.length === 0}
          >
            <Download size={14} strokeWidth={2} /> Download CSV
          </button>
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading worksheet…</div>}
      {q.isError && (
        <div className="card empty empty-error">Couldn&apos;t load: {(q.error as Error).message}</div>
      )}

      {q.data && (
        <section className="card" style={{ padding: 0 }}>
          <header className="entries-head">
            <h2 className="h3">{fmtMonth(month)} · {tz}</h2>
            <div className="entries-totals secondary">
              {q.data.rows.length} people · {q.data.totals.totalHours.toFixed(1)}h total
            </div>
          </header>
          <table className="entries-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Team</th>
                <th className="payroll-num">Days</th>
                <th className="payroll-num">Worked</th>
                <th className="payroll-num">Meetings</th>
                <th className="payroll-num">Manual</th>
                <th className="payroll-num">Total</th>
                <th className="payroll-num">Avg / day</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="tertiary" style={{ padding: 'var(--sp-5) var(--sp-6)', textAlign: 'center' }}>
                    No users in this workspace yet.
                  </td>
                </tr>
              )}
              {q.data.rows.map((r) => (
                <tr key={r.user.id} className="et-row">
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.user.name}</div>
                    <div className="small tertiary">{r.user.email}</div>
                  </td>
                  <td className="secondary small">{r.user.role}</td>
                  <td className="secondary small">{r.user.teamName ?? <span className="tertiary">—</span>}</td>
                  <td className="payroll-num tabular">{r.daysPresent}</td>
                  <td className="payroll-num tabular">{r.workedHours.toFixed(2)}</td>
                  <td className="payroll-num tabular">{r.meetingHours.toFixed(2)}</td>
                  <td className="payroll-num tabular">{r.manualHours.toFixed(2)}</td>
                  <td className="payroll-num tabular" style={{ fontWeight: 600 }}>
                    {r.totalHours.toFixed(2)}
                  </td>
                  <td className="payroll-num tabular secondary">{r.avgDayHours.toFixed(2)}</td>
                </tr>
              ))}
              {q.data.rows.length > 0 && (
                <tr className="et-row payroll-total-row">
                  <td colSpan={3} style={{ fontWeight: 600 }}>Total</td>
                  <td className="payroll-num tabular">{q.data.totals.daysPresent}</td>
                  <td className="payroll-num tabular">{q.data.totals.workedHours.toFixed(2)}</td>
                  <td className="payroll-num tabular">{q.data.totals.meetingHours.toFixed(2)}</td>
                  <td className="payroll-num tabular">{q.data.totals.manualHours.toFixed(2)}</td>
                  <td className="payroll-num tabular" style={{ fontWeight: 700 }}>
                    {q.data.totals.totalHours.toFixed(2)}
                  </td>
                  <td className="payroll-num tertiary">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

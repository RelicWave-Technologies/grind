import { useState } from 'react';
import { API_BASE } from './api';

export type MonthReportFormat = 'csv' | 'xlsx';

/**
 * Download the month performance report and hand the file over.
 *
 * Shared by Reports and Attendance because both offer the same two buttons.
 * A plain `<a download>` gave no sign anything was happening — the workbook
 * takes a few seconds to build for a hundred people — and on a failure it
 * navigated the tab to a page of JSON instead of saying what went wrong.
 *
 * `downloading` names the format in flight, so the button that was pressed is
 * the one that spins.
 */
export function useMonthReportDownload() {
  const [downloading, setDownloading] = useState<MonthReportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(month: string, format: MonthReportFormat): Promise<void> {
    setDownloading(format);
    setError(null);
    try {
      const params = new URLSearchParams({ month });
      const res = await fetch(
        `${API_BASE}/v1/reports/month-performance.${format}?${params.toString()}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const code = (body as { error?: string } | null)?.error;
        setError(
          code === 'invalid_month'
            ? 'That month could not be read. Pick a date inside a single month.'
            : res.status === 403
              ? 'You do not have permission to download this report.'
              : `The report could not be built (${res.status}).`,
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `month-performance-${month}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('The report could not be reached. Check your connection and try again.');
    } finally {
      setDownloading(null);
    }
  }

  return { download, downloading, error };
}

/** 'Aug 2026' from '2026-08' — short enough to sit inside a button label. */
export function fmtMonthShort(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** 'August 2026' from '2026-08', for tooltips where there is room. */
export function fmtMonthLong(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

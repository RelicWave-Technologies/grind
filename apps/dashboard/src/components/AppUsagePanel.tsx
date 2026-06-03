import { Monitor } from 'lucide-react';
import type { AppUsageInsight } from '../lib/types';
import { fmtDurationMs } from '../lib/format';

/**
 * Calm read-only "what apps were used" panel for /me-today (M14).
 * Renders the server-computed top-N apps as horizontal share bars.
 *
 * Hidden entirely when `totalMinutes === 0` — that covers both:
 *   - no samples landed (the user wasn't tracking)
 *   - workspace policy has captureApps OFF (server scrubs everything)
 * Either way, there's nothing useful to display, so we stay quiet.
 */
export default function AppUsagePanel({ appUsage }: { appUsage: AppUsageInsight | undefined }) {
  if (!appUsage || appUsage.totalMinutes === 0 || appUsage.topApps.length === 0) {
    return null;
  }
  const total = appUsage.totalMinutes;

  return (
    <section className="card app-usage-card" aria-label="App usage">
      <header className="app-usage-head">
        <h2 className="h3" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Monitor size={15} strokeWidth={2} aria-hidden />
          Apps & sites
        </h2>
        <span className="secondary callout">{fmtDurationMs(total * 60_000)} tracked</span>
      </header>
      <ul className="app-usage-list" role="list">
        {appUsage.topApps.map((entry) => {
          const pct = total > 0 ? Math.round((entry.minutes / total) * 100) : 0;
          return (
            <li key={`${entry.app}\x00${entry.appBundle ?? ''}`} className="app-usage-row">
              <span className="app-usage-name" title={entry.appBundle ?? undefined}>
                {entry.app}
              </span>
              <span className="app-usage-bar" aria-hidden>
                <span className="app-usage-bar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
              </span>
              <span className="app-usage-share tabular small secondary">
                {fmtDurationMs(entry.minutes * 60_000)}
                <span className="app-usage-pct"> · {pct}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

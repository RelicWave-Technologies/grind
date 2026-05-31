import type { DayInsight, DayBlock } from '../lib/types';
import { fmtTime, fmtDurationMs } from '../lib/format';

interface Props {
  day: DayInsight;
}

const KIND_LABEL: Record<DayBlock['kind'], string> = {
  WORK: 'Tracked',
  MEETING: 'Meeting',
  MANUAL: 'Manual time',
  IDLE_TRIMMED: 'Idle (trimmed)',
  GAP: 'Gap',
};

/**
 * Read-only timesheet rows for one user-day. Shows every block (incl. GAPs
 * so managers can see what's NOT covered), pending requests in a separate
 * group, and rejected ones at the foot so the requester can re-submit if
 * they were the one viewing.
 */
export function EntriesTable({ day }: Props) {
  const totalNonGap = day.totals.workedMs + day.totals.meetingMs + day.totals.manualMs;
  const hasAnyContent =
    day.blocks.some((b) => b.kind !== 'GAP') || day.pendingOverlay.length > 0 || day.recentRejected.length > 0;

  return (
    <section className="card entries-card" style={{ padding: 0 }}>
      <header className="entries-head">
        <h2 className="h3">Timesheet</h2>
        <div className="entries-totals secondary">
          {fmtDurationMs(day.totals.workedMs)} tracked
          {day.totals.meetingMs > 0 && <> · {fmtDurationMs(day.totals.meetingMs)} meeting</>}
          {day.totals.manualMs > 0 && <> · {fmtDurationMs(day.totals.manualMs)} manual</>}
          {totalNonGap > 0 && <> · {fmtDurationMs(totalNonGap)} total</>}
        </div>
      </header>

      {!hasAnyContent ? (
        <div className="empty">Nothing tracked for this day yet.</div>
      ) : (
        <table className="entries-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Time</th>
              <th>Duration</th>
              <th>Task</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {day.blocks.map((b, i) => (
              <tr key={`row-${i}-${b.startedAt}`} className={`entry-row entry-row-${b.kind.toLowerCase()}`}>
                <td>
                  <span className={`kind-chip kind-${b.kind.toLowerCase()}`}>{KIND_LABEL[b.kind]}</span>
                </td>
                <td className="tabular">
                  {fmtTime(b.startedAt)} – {b.isOpen ? <em className="tertiary">now</em> : fmtTime(b.endedAt)}
                </td>
                <td className="tabular">{fmtDurationMs(b.durationMs)}</td>
                <td className="secondary">{b.larkTaskGuid ?? <span className="tertiary">—</span>}</td>
                <td className="secondary entry-notes">
                  {b.notes ? b.notes : <span className="tertiary">—</span>}
                </td>
              </tr>
            ))}

            {day.pendingOverlay.map((p) => (
              <tr key={`pending-${p.id}`} className="entry-row entry-row-pending">
                <td>
                  <span className="kind-chip kind-pending">Pending</span>
                </td>
                <td className="tabular">
                  {fmtTime(p.startedAt)} – {fmtTime(p.endedAt)}
                </td>
                <td className="tabular">{fmtDurationMs(p.endedAt - p.startedAt)}</td>
                <td className="secondary">{p.larkTaskGuid ?? <span className="tertiary">—</span>}</td>
                <td className="secondary entry-notes">{p.reason}</td>
              </tr>
            ))}

            {day.recentRejected.map((r) => (
              <tr key={`rejected-${r.id}`} className="entry-row entry-row-rejected">
                <td>
                  <span className="kind-chip kind-rejected">Rejected</span>
                </td>
                <td className="tabular">
                  {fmtTime(r.requestedStart)} – {fmtTime(r.requestedEnd)}
                </td>
                <td className="tabular">{fmtDurationMs(r.requestedEnd - r.requestedStart)}</td>
                <td className="secondary">{r.larkTaskGuid ?? <span className="tertiary">—</span>}</td>
                <td className="secondary entry-notes">
                  {r.reason}
                  {r.decidedReason && <div className="small tertiary">Reviewer: {r.decidedReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

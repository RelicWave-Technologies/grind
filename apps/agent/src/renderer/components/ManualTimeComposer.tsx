import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Clock, X } from 'lucide-react';

/**
 * Inline composer for "Request manual time" (M10). Calm card matching the
 * TaskComposer style. Sends to /v1/time-requests via the agent IPC; the
 * backend picks the approver and fires a Lark approval card.
 *
 * Input shape we collect from the user:
 *   - date (YYYY-MM-DD, defaults to today)
 *   - start time (HH:mm)
 *   - end time (HH:mm) — same day; cross-midnight cases are rare for the
 *     "forgot to start the tracker" use case this targets
 *   - reason (required, ≥ 3 chars)
 *   - optional Lark task (guid + summary)
 *
 * We validate locally before mutating so the user gets fast feedback.
 */

type LarkTaskLite = { guid: string; summary: string };

export interface ManualTimePreset {
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  larkTaskGuid: string | null;
}

export default function ManualTimeComposer({
  larkTasks,
  onCreated,
  preset,
}: {
  larkTasks: LarkTaskLite[];
  onCreated: (status: 'PENDING') => void;
  /** Pre-fills the date/time/task fields. Reason intentionally stays empty. */
  preset?: ManualTimePreset | null;
}) {
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Seed from preset on mount + whenever the preset reference changes (e.g.
  // user clicks a different gap on the ribbon).
  const seed = useMemo(() => {
    if (!preset) return { date: todayStr, start: '09:00', end: '10:00', taskGuid: '' };
    const sd = new Date(preset.startedAt);
    const ed = new Date(preset.endedAt);
    const ymd = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`;
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { date: ymd, start: hhmm(sd), end: hhmm(ed), taskGuid: preset.larkTaskGuid ?? '' };
  }, [preset, todayStr]);

  const [date, setDate] = useState(seed.date);
  const [start, setStart] = useState(seed.start);
  const [end, setEnd] = useState(seed.end);
  const [reason, setReason] = useState('');
  const [taskGuid, setTaskGuid] = useState<string>(seed.taskGuid);

  // Re-seed when the preset reference identity changes (e.g. user clicks
  // a different gap). Reason stays empty intentionally.
  useEffect(() => {
    setDate(seed.date);
    setStart(seed.start);
    setEnd(seed.end);
    setTaskGuid(seed.taskGuid);
  }, [seed]);

  const startedAtMs = useMemo(() => new Date(`${date}T${start}:00`).getTime(), [date, start]);
  const endedAtMs = useMemo(() => new Date(`${date}T${end}:00`).getTime(), [date, end]);
  const durationMin = Math.max(0, Math.round((endedAtMs - startedAtMs) / 60000));
  const reasonOk = reason.trim().length >= 3;
  const rangeOk = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && startedAtMs < endedAtMs;
  const futureOk = endedAtMs <= Date.now() + 60_000; // can't request future time
  const ready = reasonOk && rangeOk && futureOk;

  const create = useMutation({
    mutationFn: () => {
      const task = larkTasks.find((t) => t.guid === taskGuid);
      return window.agent.timeRequests.create({
        requestedStart: startedAtMs,
        requestedEnd: endedAtMs,
        reason: reason.trim(),
        larkTaskGuid: task?.guid ?? null,
        taskSummary: task?.summary ?? null,
      });
    },
    onSuccess: (r) => {
      if (r.ok && r.request) {
        setReason('');
        setTaskGuid('');
        onCreated('PENDING');
      }
    },
  });

  const err = create.data && !create.data.ok ? create.data.error : null;
  const friendlyErr =
    err === 'invalid_range_or_no_approver'
      ? 'No approver available, or the time range is invalid.'
      : err === 'duplicate'
        ? 'Looks like a duplicate request.'
        : err
          ? 'Could not submit. Try again.'
          : null;

  return (
    <div className="composer rise rise-1">
      <div className="composer-row" style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <label className="composer-due no-drag" title="Date">
          <Clock size={15} strokeWidth={2} />
          <input type="date" value={date} max={todayStr} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="composer-due no-drag" title="Start time">
          <span className="small secondary">Start</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="composer-due no-drag" title="End time">
          <span className="small secondary">End</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <span className="small secondary" style={{ alignSelf: 'center' }}>
          {rangeOk ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : '—'}
        </span>
      </div>

      {larkTasks.length > 0 && (
        <label className="composer-due no-drag" style={{ marginTop: 'var(--sp-2)' }}>
          <span className="small secondary">Task (optional)</span>
          <select value={taskGuid} onChange={(e) => setTaskGuid(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            <option value="">— None / Untracked —</option>
            {larkTasks.map((t) => (
              <option key={t.guid} value={t.guid}>{t.summary}</option>
            ))}
          </select>
        </label>
      )}

      <textarea
        className="composer-note no-drag"
        placeholder="Reason (required) — e.g., Forgot to start tracker after lunch"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div className="composer-foot">
        {!rangeOk && <span className="composer-error"><X size={13} strokeWidth={2.5} /> End must be after start</span>}
        {rangeOk && !futureOk && <span className="composer-error"><X size={13} strokeWidth={2.5} /> Can't request future time</span>}
        {friendlyErr && <span className="composer-error"><X size={13} strokeWidth={2.5} /> {friendlyErr}</span>}
        <span className="composer-spacer" />
        <button className="btn btn-prominent no-drag" onClick={() => create.mutate()} disabled={!ready || create.isPending}>
          {create.isPending ? 'Sending…' : 'Send to approver'}
        </button>
      </div>
    </div>
  );
}

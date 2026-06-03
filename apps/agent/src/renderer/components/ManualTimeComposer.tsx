import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Clock, X, Users } from 'lucide-react';

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
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attOpen, setAttOpen] = useState(false);
  const [attQuery, setAttQuery] = useState('');
  const attRef = useRef<HTMLDivElement>(null);

  // Pull the workspace directory once; cached by TanStack Query so reopening
  // the composer doesn't re-fetch. Empty list means the user has no
  // teammates to tag — picker still renders but shows "No matches".
  const wsUsersQ = useQuery({
    queryKey: ['workspace', 'users'],
    queryFn: () => window.agent.timeRequests.listWorkspaceUsers(),
    staleTime: 5 * 60_000,
  });
  const wsUsers = wsUsersQ.data?.users ?? [];
  const selectedUsers = useMemo(
    () => wsUsers.filter((u) => attendees.includes(u.id)),
    [wsUsers, attendees],
  );
  const attResults = useMemo(() => {
    const q = attQuery.trim().toLowerCase();
    if (q === '') return wsUsers.slice(0, 50);
    return wsUsers
      .filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .slice(0, 50);
  }, [wsUsers, attQuery]);

  useEffect(() => {
    if (!attOpen) return;
    function onDoc(e: MouseEvent) {
      if (!attRef.current?.contains(e.target as Node)) {
        setAttOpen(false);
        setAttQuery('');
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [attOpen]);

  function toggleAttendee(id: string) {
    setAttendees((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Re-seed when the preset reference identity changes (e.g. user clicks
  // a different gap). Reason + attendees stay empty intentionally.
  useEffect(() => {
    setDate(seed.date);
    setStart(seed.start);
    setEnd(seed.end);
    setTaskGuid(seed.taskGuid);
    setAttendees([]);
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
        attendeeIds: attendees.length > 0 ? attendees : undefined,
      });
    },
    onSuccess: (r) => {
      if (r.ok && r.request) {
        setReason('');
        setTaskGuid('');
        setAttendees([]);
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

      <div ref={attRef} className="composer-attendees no-drag" style={{ marginTop: 'var(--sp-2)', position: 'relative' }}>
        <button
          type="button"
          className="btn btn-ghost no-drag"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setAttOpen((o) => !o)}
          title="Tag the teammates who were in this meeting"
        >
          <Users size={13} strokeWidth={2} />
          <span className="small">
            {selectedUsers.length === 0
              ? '+ Attendees (optional)'
              : selectedUsers.length === 1
                ? selectedUsers[0]?.name ?? '1 attendee'
                : `${selectedUsers.length} attendees`}
          </span>
        </button>
        {selectedUsers.length > 0 && !attOpen && (
          <span className="small tertiary" style={{ marginLeft: 8 }}>
            {selectedUsers.slice(0, 3).map((u) => u.name).join(', ')}
            {selectedUsers.length > 3 ? ` +${selectedUsers.length - 3}` : ''}
          </span>
        )}
        {attOpen && (
          <div
            className="composer-attendees-pop"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 30,
              width: 320,
              maxHeight: 320,
              overflow: 'hidden',
              background: 'var(--bg-elevated, #fff)',
              border: '1px solid var(--border-default, #e5e5e7)',
              borderRadius: 10,
              boxShadow: '0 10px 32px rgba(0,0,0,0.12)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <input
              autoFocus
              className="composer-attendees-search no-drag"
              placeholder="Search workspace…"
              value={attQuery}
              onChange={(e) => setAttQuery(e.target.value)}
              style={{
                padding: '8px 10px',
                border: 'none',
                borderBottom: '1px solid var(--border-default, #e5e5e7)',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
              }}
            />
            <div style={{ overflow: 'auto', maxHeight: 260 }}>
              {wsUsersQ.isLoading && <div className="small tertiary" style={{ padding: '10px' }}>Loading…</div>}
              {!wsUsersQ.isLoading && attResults.length === 0 && (
                <div className="small tertiary" style={{ padding: '10px' }}>No matches</div>
              )}
              {attResults.map((u) => {
                const isSel = attendees.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleAttendee(u.id)}
                    className="no-drag"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '8px 10px',
                      background: isSel ? 'var(--bg-selected, rgba(99,102,241,0.08))' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13 }}>{u.name}</span>
                      <span className="small tertiary" style={{ display: 'block' }}>{u.email}</span>
                    </span>
                    {isSel && <span style={{ color: 'var(--accent, #6366f1)', fontSize: 13 }}>✓</span>}
                  </button>
                );
              })}
            </div>
            {selectedUsers.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost no-drag"
                style={{ borderTop: '1px solid var(--border-default, #e5e5e7)', borderRadius: 0, justifyContent: 'center' }}
                onClick={() => setAttendees([])}
              >
                <X size={12} strokeWidth={2.2} /> Clear all
              </button>
            )}
          </div>
        )}
      </div>

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

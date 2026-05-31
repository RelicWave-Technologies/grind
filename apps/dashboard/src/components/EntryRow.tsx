import { useEffect, useState } from 'react';
import { Send, Loader2, Check, X, AlertCircle, RotateCcw } from 'lucide-react';
import TimePopover from './TimePopover';
import TaskCombo, { type TaskOption } from './TaskCombo';
import { fmtTime, fmtDurationMs } from '../lib/format';
import type { DayBlock, PendingOverlay, RejectedRequest } from '../lib/types';

/**
 * Polymorphic row used by /me-today's timesheet. Mirrors the agent's
 * EntryRow contract:
 *
 *   - kind='tracked' (AUTO TimeEntry, green stripe): inline edit of task +
 *     notes via PATCH /v1/time-entries/:id.
 *   - kind='manual_approved' (APPROVED MANUAL TimeEntry, amber tint):
 *     same inline edit; the request is past tense, the entry is mutable.
 *   - kind='pending' (PENDING ManualTimeRequest, red tint): inline edit
 *     of time + task + reason via PATCH /v1/time-requests/:id, plus a
 *     Withdraw action (POST /:id/cancel).
 *   - kind='gap' (no entry, white): a composer for a fresh manual-time
 *     request — pick start / end / task / reason → POST /v1/time-requests.
 *
 * `disabled=true` short-circuits ALL writes — used when the dashboard
 * viewer is looking at a teammate's day (read-only).
 */

export type RowKind = 'tracked' | 'manual_approved' | 'pending' | 'gap';

interface BaseProps {
  tasks: TaskOption[];
  disabled?: boolean;
  /** Tick counter from the parent — when bumped, gap row syncs to fresh preset. */
  presetTick?: number;
  preset?: { startedAt: number; endedAt: number };
}

interface TrackedRowProps extends BaseProps {
  kind: 'tracked' | 'manual_approved';
  block: DayBlock;
  onSave: (vars: { id: string; larkTaskGuid: string | null; notes: string }) => Promise<void>;
}

interface PendingRowProps extends BaseProps {
  kind: 'pending';
  pending: PendingOverlay;
  onPatch: (vars: {
    id: string;
    requestedStart: number;
    requestedEnd: number;
    larkTaskGuid: string | null;
    reason: string;
  }) => Promise<void>;
  onWithdraw: (id: string) => Promise<void>;
}

interface GapRowProps extends BaseProps {
  kind: 'gap';
  block: DayBlock;
  onCreate: (vars: {
    requestedStart: number;
    requestedEnd: number;
    larkTaskGuid: string | null;
    reason: string;
  }) => Promise<void>;
}

interface RejectedRowProps {
  kind: 'rejected';
  rejected: RejectedRequest;
}

export type EntryRowProps = TrackedRowProps | PendingRowProps | GapRowProps | RejectedRowProps;

export function EntryRow(props: EntryRowProps) {
  if (props.kind === 'rejected') return <RejectedRow rejected={props.rejected} />;
  if (props.kind === 'gap') return <GapRow {...props} />;
  if (props.kind === 'pending') return <PendingRow {...props} />;
  return <TrackedRow {...props} />;
}

// ---------------------------------------------------------------------------
// Tracked + Approved-manual: editable task + notes
// ---------------------------------------------------------------------------

function TrackedRow({ block, kind, tasks, disabled, onSave }: TrackedRowProps) {
  const [task, setTask] = useState<string>(block.larkTaskGuid ?? '');
  const [notes, setNotes] = useState<string>(block.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the block changes underneath (re-fetch landed).
  useEffect(() => {
    setTask(block.larkTaskGuid ?? '');
    setNotes(block.notes ?? '');
  }, [block.timeEntryId, block.larkTaskGuid, block.notes]);

  const dirty = (task || '') !== (block.larkTaskGuid ?? '') || notes !== (block.notes ?? '');

  async function save() {
    if (!block.timeEntryId || !dirty) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave({ id: block.timeEntryId, larkTaskGuid: task || null, notes });
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setTask(block.larkTaskGuid ?? '');
    setNotes(block.notes ?? '');
    setErr(null);
  }

  return (
    <tr className={`et-row et-row-${kind === 'tracked' ? 'tracked' : 'manual'}${dirty ? ' et-row-dirty' : ''}`}>
      <td className="et-time-cell tabular">
        <KindBadge kind={kind} />
      </td>
      <td className="et-time-cell tabular">
        {fmtTime(block.startedAt)} <span className="et-times-sep">–</span>{' '}
        {block.isOpen ? <em className="tertiary">now</em> : fmtTime(block.endedAt)}
      </td>
      <td className="tabular secondary">{fmtDurationMs(block.durationMs)}</td>
      <td>
        <TaskCombo
          tasks={tasks}
          value={task}
          disabled={disabled || !block.timeEntryId}
          onChange={setTask}
          ariaLabel="Task"
        />
      </td>
      <td>
        <input
          className="et-reason"
          placeholder="Notes…"
          value={notes}
          maxLength={500}
          disabled={disabled || !block.timeEntryId}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) save();
            if (e.key === 'Escape') reset();
          }}
        />
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell" style={{ textAlign: 'right' }}>
        {!disabled && (
          <span className="et-actions">
            {dirty && (
              <button type="button" className="et-row-btn" onClick={reset} disabled={saving}>
                <RotateCcw size={11} strokeWidth={2.2} /> Reset
              </button>
            )}
            <button
              type="button"
              className="et-row-btn et-row-btn-primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? <Loader2 size={12} className="spin" /> : saved ? <Check size={12} strokeWidth={2.4} /> : null}
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Pending request: edit time / task / reason + Withdraw
// ---------------------------------------------------------------------------

function PendingRow({ pending, tasks, disabled, onPatch, onWithdraw }: PendingRowProps) {
  const [start, setStart] = useState(pending.startedAt);
  const [end, setEnd] = useState(pending.endedAt);
  const [task, setTask] = useState<string>(pending.larkTaskGuid ?? '');
  const [reason, setReason] = useState(pending.reason);
  const [busy, setBusy] = useState<'save' | 'withdraw' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setStart(pending.startedAt);
    setEnd(pending.endedAt);
    setTask(pending.larkTaskGuid ?? '');
    setReason(pending.reason);
  }, [pending.id, pending.startedAt, pending.endedAt, pending.larkTaskGuid, pending.reason]);

  const dirty =
    start !== pending.startedAt ||
    end !== pending.endedAt ||
    (task || '') !== (pending.larkTaskGuid ?? '') ||
    reason !== pending.reason;

  async function save() {
    if (!dirty) return;
    setBusy('save');
    setErr(null);
    try {
      await onPatch({ id: pending.id, requestedStart: start, requestedEnd: end, larkTaskGuid: task || null, reason });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    setBusy('withdraw');
    setErr(null);
    try {
      await onWithdraw(pending.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Withdraw failed');
    } finally {
      setBusy(null);
    }
  }

  const duration = Math.max(0, end - start);

  return (
    <tr className={`et-row et-row-pending-edit${dirty ? ' et-row-dirty' : ''}`}>
      <td><KindBadge kind="pending" /></td>
      <td className="et-time-cell">
        <span className="et-times-inline">
          <TimePopover value={start} disabled={disabled} maxTime={end - 60_000} onChange={setStart} ariaLabel="Start" />
          <span className="et-times-sep">–</span>
          <TimePopover value={end} disabled={disabled} minTime={start + 60_000} onChange={setEnd} ariaLabel="End" />
        </span>
      </td>
      <td className="tabular secondary">{fmtDurationMs(duration)}</td>
      <td>
        <TaskCombo tasks={tasks} value={task} disabled={disabled} onChange={setTask} ariaLabel="Task" />
      </td>
      <td>
        <input
          className="et-reason"
          placeholder="Reason for the manual time…"
          value={reason}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell" style={{ textAlign: 'right' }}>
        {!disabled && (
          <span className="et-actions">
            <button type="button" className="et-row-btn et-row-btn-danger" onClick={withdraw} disabled={busy !== null}>
              {busy === 'withdraw' ? <Loader2 size={12} className="spin" /> : <X size={12} strokeWidth={2.4} />}
              Withdraw
            </button>
            <button
              type="button"
              className="et-row-btn et-row-btn-primary"
              onClick={save}
              disabled={busy !== null || !dirty || reason.trim().length === 0}
            >
              {busy === 'save' ? <Loader2 size={12} className="spin" /> : null}
              {busy === 'save' ? 'Saving…' : 'Update'}
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Gap row: composer for a fresh manual-time request
// ---------------------------------------------------------------------------

function GapRow({ block, tasks, disabled, preset, presetTick, onCreate }: GapRowProps) {
  // Default to a 1h slice in the MIDDLE of the gap so the user gets a sane
  // starting point and can drag with the popover.
  const defaultRange = (b: DayBlock): { startedAt: number; endedAt: number } => {
    const mid = (b.startedAt + b.endedAt) / 2;
    const slice = Math.min(60 * 60_000, b.durationMs);
    return { startedAt: Math.round(mid - slice / 2), endedAt: Math.round(mid + slice / 2) };
  };
  const initial = preset ?? defaultRange(block);
  const [start, setStart] = useState(initial.startedAt);
  const [end, setEnd] = useState(initial.endedAt);
  const [task, setTask] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // When the parent fires a click-to-fill (presetTick changes), snap to that preset.
  useEffect(() => {
    if (preset) {
      setStart(preset.startedAt);
      setEnd(preset.endedAt);
    }
  }, [presetTick]);

  // Reset on block change (different gap row entirely).
  useEffect(() => {
    const r = defaultRange(block);
    setStart(r.startedAt);
    setEnd(r.endedAt);
    setTask('');
    setReason('');
    setErr(null);
  }, [block.startedAt, block.endedAt]);

  const duration = Math.max(0, end - start);

  async function submit() {
    if (reason.trim().length === 0) {
      setErr('Reason is required');
      return;
    }
    if (duration <= 0) {
      setErr('End must be after start');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onCreate({ requestedStart: start, requestedEnd: end, larkTaskGuid: task || null, reason });
      // Reset for the next gap-fill on the same row.
      const r = defaultRange(block);
      setStart(r.startedAt);
      setEnd(r.endedAt);
      setTask('');
      setReason('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="et-row et-row-gap">
      <td><KindBadge kind="gap" /></td>
      <td className="et-time-cell">
        {disabled ? (
          <span className="tabular secondary">
            {fmtTime(block.startedAt)} – {fmtTime(block.endedAt)}
          </span>
        ) : (
          <span className="et-times-inline">
            <TimePopover
              value={start}
              minTime={block.startedAt}
              maxTime={Math.max(block.startedAt, end - 60_000)}
              onChange={setStart}
              ariaLabel="Start"
            />
            <span className="et-times-sep">–</span>
            <TimePopover
              value={end}
              minTime={Math.min(block.endedAt, start + 60_000)}
              maxTime={block.endedAt}
              onChange={setEnd}
              ariaLabel="End"
            />
          </span>
        )}
      </td>
      <td className="tabular secondary">{fmtDurationMs(disabled ? block.durationMs : duration)}</td>
      <td>
        {disabled ? (
          <span className="tertiary">—</span>
        ) : (
          <TaskCombo tasks={tasks} value={task} onChange={setTask} ariaLabel="Task" />
        )}
      </td>
      <td>
        {disabled ? (
          <span className="tertiary">Untracked</span>
        ) : (
          <input
            className="et-reason"
            placeholder="Why is this time missing? (required)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reason.trim()) submit();
            }}
          />
        )}
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell" style={{ textAlign: 'right' }}>
        {!disabled && (
          <span className="et-actions" style={{ opacity: reason ? 1 : undefined }}>
            <button
              type="button"
              className="et-row-btn et-row-btn-primary"
              onClick={submit}
              disabled={busy || !reason.trim() || duration <= 0}
            >
              {busy ? <Loader2 size={12} className="spin" /> : <Send size={12} strokeWidth={2.2} />}
              {busy ? 'Sending…' : 'Send for approval'}
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Rejected row (read-only summary)
// ---------------------------------------------------------------------------

function RejectedRow({ rejected }: { rejected: RejectedRequest }) {
  return (
    <tr className="et-row entry-row-rejected">
      <td><KindBadge kind="rejected" /></td>
      <td className="et-time-cell tabular">
        {fmtTime(rejected.requestedStart)} <span className="et-times-sep">–</span> {fmtTime(rejected.requestedEnd)}
      </td>
      <td className="tabular secondary">{fmtDurationMs(rejected.requestedEnd - rejected.requestedStart)}</td>
      <td className="secondary">{rejected.larkTaskGuid ?? <span className="tertiary">—</span>}</td>
      <td>
        <div>{rejected.reason}</div>
        {rejected.decidedReason && (
          <div className="small tertiary" style={{ marginTop: 2 }}>
            <AlertCircle size={10} strokeWidth={2.2} /> Reviewer: {rejected.decidedReason}
          </div>
        )}
      </td>
      <td />
    </tr>
  );
}

// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: RowKind | 'rejected' }) {
  const label =
    kind === 'tracked' ? 'Tracked'
    : kind === 'manual_approved' ? 'Manual'
    : kind === 'pending' ? 'Pending'
    : kind === 'rejected' ? 'Rejected'
    : 'Gap';
  return <span className={`kind-chip kind-${kind === 'manual_approved' ? 'manual' : kind}`}>{label}</span>;
}

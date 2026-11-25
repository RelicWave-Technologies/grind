import { useEffect, useRef, useState } from 'react';
import { Send, Check, X, AlertCircle, RotateCcw, Trash2, Scissors, Undo2 } from 'lucide-react';
import TimePopover from './TimePopover';
import TaskCombo, { type TaskOption } from './TaskCombo';
import AttendeePicker, { type WorkspaceUser } from './AttendeePicker';
import AttendeeChips from './AttendeeChips';
import { TIME_REMOVAL_MIN_MS, TIME_REMOVAL_REASON_MAX, TIME_REMOVAL_REASON_MIN } from '@grind/types';
import { fmtDateShort, fmtTime, fmtDurationMs } from '../lib/format';
import type { DayBlock, RejectedRequest } from '../lib/types';
import { Button } from '../ui';

/**
 * Polymorphic row used by /edit-time's timesheet. Mirrors the agent's
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
 *   - kind='removed' (time that was taken out, grey rail): read-only — the
 *     stretch, the reason, who removed it. A manager may restore it.
 *
 * A tracked row can also open the Remove time composer: pick a range inside
 * the block and say why → POST /v1/time-removals. It only ever takes time
 * away; there is no way to lengthen tracked time from here.
 *
 * `disabled=true` short-circuits ALL writes. The parent decides this from
 * scoped RBAC; the API repeats the same check server-side.
 */

type RowKind = 'tracked' | 'manual_approved' | 'pending' | 'gap';

interface BaseProps {
  tasks: TaskOption[];
  timeZone: string;
  disabled?: boolean;
  /** Tick counter from the parent — when bumped, gap row syncs to fresh preset. */
  presetTick?: number;
  preset?: { startedAt: number; endedAt: number };
  /** Hover-link from the ribbon. When set, the row paints a soft violet rail. */
  rowId?: string;
  highlighted?: boolean;
  /** Workspace directory for the attendee picker (id+name+email). */
  workspaceUsers?: WorkspaceUser[];
  /** Current user — filtered out of the picker (implicit attendee). */
  selfId?: string;
}

interface TrackedRowProps extends BaseProps {
  kind: 'tracked' | 'manual_approved';
  block: DayBlock;
  /** True if the block's underlying entry has a MEETING segment.
   *  Attendees can only be tagged on those (server rejects otherwise). */
  isMeeting?: boolean;
  onSave: (vars: { id: string; larkTaskGuid: string | null; notes: string; attendeeIds?: string[] }) => Promise<void>;
  onDeleteManual?: (id: string) => Promise<void>;
  /** Take part of this tracked block out of the day. Tracked rows only. */
  onRemoveTime?: (vars: { start: number; end: number; reason: string }) => Promise<void>;
}

interface RemovedRowProps {
  kind: 'removed';
  block: DayBlock;
  tasks: TaskOption[];
  timeZone: string;
  selfId?: string;
  rowId?: string;
  highlighted?: boolean;
  /** Given only to someone who may put this time back (a manager, never the person themselves). */
  onRestore?: (removalId: string) => Promise<void>;
}

interface PendingRowProps extends BaseProps {
  kind: 'pending';
  /** A PENDING block from the partition (carries requestId + reason). */
  block: DayBlock;
  onPatch: (vars: {
    id: string;
    requestedStart: number;
    requestedEnd: number;
    larkTaskGuid: string | null;
    taskSummary: string | null;
    reason: string;
    attendeeIds: string[];
  }) => Promise<void>;
  onWithdraw: (id: string) => Promise<void>;
}

interface GapRowProps extends BaseProps {
  kind: 'gap';
  block: DayBlock;
  onCreate: (vars: {
    /** Idempotency key for POST /v1/time-requests — one per composed request. */
    clientUuid: string;
    requestedStart: number;
    requestedEnd: number;
    larkTaskGuid: string | null;
    taskSummary: string | null;
    reason: string;
    attendeeIds: string[];
  }) => Promise<void>;
}

interface RejectedRowProps {
  kind: 'rejected';
  rejected: RejectedRequest;
  timeZone: string;
  rowId?: string;
  highlighted?: boolean;
}

export type EntryRowProps = TrackedRowProps | PendingRowProps | GapRowProps | RejectedRowProps | RemovedRowProps;

function newClientUuid(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `web-${random}`;
}

/** Order-independent equality check for two string arrays. */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}

function taskSummaryFor(tasks: TaskOption[], guid: string, fallback?: string | null): string | null {
  const trimmedGuid = guid.trim();
  if (!trimmedGuid) return null;
  const label = tasks.find((task) => task.guid === trimmedGuid)?.summary?.trim() ?? fallback?.trim() ?? '';
  return label.length > 0 ? label : null;
}

export function EntryRow(props: EntryRowProps) {
  if (props.kind === 'rejected') return <RejectedRow {...props} />;
  if (props.kind === 'removed') return <RemovedRow {...props} />;
  if (props.kind === 'gap') return <GapRow {...props} />;
  if (props.kind === 'pending') return <PendingRow {...props} />;
  return <TrackedRow {...props} />;
}

// ---------------------------------------------------------------------------
// Tracked + Approved-manual: editable task + notes
// ---------------------------------------------------------------------------

function TrackedRow({
  block,
  kind,
  tasks,
  timeZone,
  disabled,
  rowId,
  highlighted,
  isMeeting,
  workspaceUsers,
  selfId,
  onSave,
  onDeleteManual,
  onRemoveTime,
}: TrackedRowProps) {
  const [removing, setRemoving] = useState(false);
  const [task, setTask] = useState<string>(block.larkTaskGuid ?? '');
  const [notes, setNotes] = useState<string>(block.notes ?? '');
  const [attendees, setAttendees] = useState<string[]>(block.attendeeIds ?? []);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the block changes underneath (re-fetch landed).
  useEffect(() => {
    setTask(block.larkTaskGuid ?? '');
    setNotes(block.notes ?? '');
    setAttendees(block.attendeeIds ?? []);
  }, [block.timeEntryId, block.larkTaskGuid, block.notes, block.attendeeIds]);

  const dirty =
    (task || '') !== (block.larkTaskGuid ?? '') ||
    notes !== (block.notes ?? '') ||
    !sameStringSet(attendees, block.attendeeIds ?? []);

  async function save() {
    if (!block.timeEntryId || !dirty) return;
    setSaving(true);
    setErr(null);
    try {
      const vars: { id: string; larkTaskGuid: string | null; notes: string; attendeeIds?: string[] } = {
        id: block.timeEntryId,
        larkTaskGuid: task || null,
        notes,
      };
      // Only send attendees when this is a MEETING row + they changed,
      // so the server never sees a tagging attempt on a WORK entry.
      if (isMeeting && !sameStringSet(attendees, block.attendeeIds ?? [])) {
        vars.attendeeIds = attendees;
      }
      await onSave(vars);
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
    setAttendees(block.attendeeIds ?? []);
    setErr(null);
  }

  async function deleteManual() {
    if (kind !== 'manual_approved' || !block.timeEntryId || !onDeleteManual) return;
    setDeleting(true);
    setErr(null);
    try {
      await onDeleteManual(block.timeEntryId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  const canRemove = kind === 'tracked' && !disabled && Boolean(onRemoveTime) && block.durationMs >= TIME_REMOVAL_MIN_MS;

  return (
    <>
    <tr
      data-row-id={rowId}
      className={`et-row et-row-${kind === 'tracked' ? 'tracked' : 'manual'}${dirty || removing ? ' et-row-dirty' : ''}${highlighted ? ' et-row-highlighted' : ''}`}
    >
      <td className="et-time-cell tabular">
        <KindBadge kind={isMeeting ? 'meeting' : kind} />
      </td>
      <td className="et-time-cell tabular">
        {fmtTime(block.startedAt, timeZone)} <span className="et-times-sep">–</span>{' '}
        {block.isOpen ? <em className="tertiary">now</em> : fmtTime(block.endedAt, timeZone)}
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
        {kind === 'manual_approved' && block.reason && (
          <div className="et-manual-reason small secondary">
            <span className="tertiary">Reason · </span>{block.reason}
          </div>
        )}
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
        {isMeeting && (
          <div className="et-attendees">
            <AttendeePicker
              users={workspaceUsers ?? []}
              selected={attendees}
              disabled={disabled || !block.timeEntryId}
              excludeIds={selfId ? [selfId] : []}
              onChange={setAttendees}
              ariaLabel="Meeting attendees"
            />
          </div>
        )}
        {/* MANUAL rows can't carry attendees (server constraint), but the
            insight payload still types attendeeIds on the block — surface
            them as read-only chips if present so the timeline doesn't
            silently drop context. */}
        {!isMeeting && (block.attendeeIds?.length ?? 0) > 0 && (
          <div className="et-attendees">
            <AttendeeChips users={workspaceUsers ?? []} attendeeIds={block.attendeeIds ?? []} />
          </div>
        )}
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell">
        {!disabled && (
          <span className="et-actions">
            {dirty && (
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={12} strokeWidth={2} />}
                onClick={reset}
                disabled={saving || deleting}
              >
                Reset
              </Button>
            )}
            {kind === 'manual_approved' && onDeleteManual && block.timeEntryId && (
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={12} strokeWidth={2} />}
                onClick={deleteManual}
                loading={deleting}
                disabled={saving || deleting}
              >
                Delete
              </Button>
            )}
            {canRemove && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Scissors size={12} strokeWidth={2} />}
                onClick={() => setRemoving((open) => !open)}
                aria-expanded={removing}
                disabled={saving}
              >
                Remove time
              </Button>
            )}
            <Button
              size="sm"
              variant={saved ? 'soft' : 'primary'}
              icon={saved ? <Check size={13} strokeWidth={2.2} /> : undefined}
              onClick={save}
              loading={saving}
              disabled={deleting || (!saving && !dirty && !saved)}
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </Button>
          </span>
        )}
      </td>
    </tr>
    {removing && canRemove && onRemoveTime && (
      <RemoveTimeRow
        block={block}
        timeZone={timeZone}
        onCancel={() => setRemoving(false)}
        onRemove={async (vars) => {
          await onRemoveTime(vars);
          setRemoving(false);
        }}
      />
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Remove time: take a range out of a tracked block, with a reason
// ---------------------------------------------------------------------------

const REMOVE_ERRORS: Record<string, string> = {
  no_tracked_time: 'There is no counted tracked time in that range.',
  window_in_future: 'That range is not over yet.',
  window_too_short: 'Pick at least one minute.',
  invalid_window: 'End must be after start.',
  forbidden: 'You can’t change this person’s time.',
};

function RemoveTimeRow({
  block,
  timeZone,
  onCancel,
  onRemove,
}: {
  block: DayBlock;
  timeZone: string;
  onCancel: () => void;
  onRemove: (vars: { start: number; end: number; reason: string }) => Promise<void>;
}) {
  // Starts on the whole block; the person narrows it to the part that was not
  // work. The pickers cannot leave the block, so this can only take time away.
  const [start, setStart] = useState(block.startedAt);
  const [end, setEnd] = useState(block.endedAt);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    reasonRef.current?.focus({ preventScroll: true });
  }, []);

  // A running block's end moves with every refetch; keep the picked range inside it.
  useEffect(() => {
    setStart((st) => Math.min(Math.max(st, block.startedAt), block.endedAt));
    setEnd((e) => Math.min(Math.max(e, block.startedAt), block.endedAt));
  }, [block.startedAt, block.endedAt]);

  const duration = Math.max(0, end - start);
  const reasonOk = reason.trim().length >= TIME_REMOVAL_REASON_MIN;
  const rangeOk = duration >= TIME_REMOVAL_MIN_MS;

  async function submit() {
    if (!reasonOk || !rangeOk || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onRemove({ start, end, reason: reason.trim() });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setErr(REMOVE_ERRORS[code] ?? (code || 'Could not remove the time'));
      setBusy(false);
    }
  }

  // The same six columns as every other row: time, how much, why, the action.
  return (
    <tr className="et-row et-row-removing">
      <td><span className="kind-chip kind-removed">Remove</span></td>
      <td className="et-time-cell">
        <span className="et-times-inline">
          <TimePopover
            value={start}
            timeZone={timeZone}
            minTime={block.startedAt}
            maxTime={Math.max(block.startedAt, end - TIME_REMOVAL_MIN_MS)}
            onChange={setStart}
            ariaLabel="Remove from"
          />
          <span className="et-times-sep">–</span>
          <TimePopover
            value={end}
            timeZone={timeZone}
            minTime={Math.min(block.endedAt, start + TIME_REMOVAL_MIN_MS)}
            maxTime={block.endedAt}
            onChange={setEnd}
            ariaLabel="Remove until"
          />
        </span>
      </td>
      <td className="tabular secondary">−{fmtDurationMs(duration)}</td>
      <td className="tertiary">—</td>
      <td>
        <input
          ref={reasonRef}
          className="et-reason"
          placeholder="Reason (required)"
          value={reason}
          maxLength={TIME_REMOVAL_REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
        />
        {err
          ? <div className="et-row-err">{err}</div>
          : <div className="small tertiary et-review-note">Only a manager can undo this.</div>}
      </td>
      <td className="et-action-cell">
        <span className="et-actions">
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            size="sm"
            variant="danger"
            onClick={submit}
            loading={busy}
            disabled={busy || !reasonOk || !rangeOk}
          >
            {busy ? 'Removing…' : `Remove ${fmtDurationMs(duration)}`}
          </Button>
        </span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Removed time (read-only; a manager may restore it)
// ---------------------------------------------------------------------------

function RemovedRow({ block, tasks, timeZone, selfId, rowId, highlighted, onRestore }: RemovedRowProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const removal = block.removal;
  const byReview = removal?.source === 'REVIEW';
  const who = removal?.byUserId && removal.byUserId === selfId ? 'you' : removal?.byName ?? (byReview ? 'a reviewer' : 'someone');
  const when = removal ? `${fmtDateShort(removal.at, timeZone)}, ${fmtTime(removal.at, timeZone)}` : null;
  const task = block.larkTaskGuid ? taskSummaryFor(tasks, block.larkTaskGuid) : null;
  const canRestore = Boolean(onRestore && removal && !byReview);

  async function restore() {
    if (!removal || !onRestore) return;
    setBusy(true);
    setErr(null);
    try {
      await onRestore(removal.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Restore failed');
      setBusy(false);
    }
  }

  return (
    <tr data-row-id={rowId} className={`et-row et-row-removed${highlighted ? ' et-row-highlighted' : ''}`}>
      <td><KindBadge kind={byReview ? 'excluded' : 'removed'} /></td>
      <td className="et-time-cell tabular et-removed-struck">
        {fmtTime(block.startedAt, timeZone)} <span className="et-times-sep">–</span> {fmtTime(block.endedAt, timeZone)}
      </td>
      <td className="tabular et-removed-struck">{fmtDurationMs(block.durationMs)}</td>
      <td className="secondary">{task ?? <span className="tertiary">—</span>}</td>
      {/* With nothing to do in the actions column, the reason takes its room. */}
      <td colSpan={canRestore ? 1 : 2}>
        <div className="et-removed-reason">
          {removal?.reason ?? (byReview ? 'A reviewer excluded this time.' : 'Not counted.')}
        </div>
        {removal && (
          <div className="small tertiary et-review-note">
            {byReview ? 'Excluded' : 'Removed'} by {who}{when ? ` · ${when}` : ''}
          </div>
        )}
        {err && <div className="et-row-err">{err}</div>}
      </td>
      {canRestore && (
        <td className="et-action-cell">
          <span className="et-actions">
            <Button
              size="sm"
              variant="secondary"
              icon={<Undo2 size={12} strokeWidth={2} />}
              onClick={restore}
              loading={busy}
              disabled={busy}
            >
              Restore
            </Button>
          </span>
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Pending request: edit time / task / reason + Withdraw
// ---------------------------------------------------------------------------

function PendingRow({
  block,
  tasks,
  timeZone,
  disabled,
  rowId,
  highlighted,
  workspaceUsers,
  selfId,
  onPatch,
  onWithdraw,
}: PendingRowProps) {
  const requestId = block.requestId ?? '';
  const baseReason = block.reason ?? '';
  const [start, setStart] = useState(block.startedAt);
  const [end, setEnd] = useState(block.endedAt);
  const [task, setTask] = useState<string>(block.larkTaskGuid ?? '');
  const [reason, setReason] = useState(baseReason);
  const [attendees, setAttendees] = useState<string[]>(block.attendeeIds ?? []);
  const [busy, setBusy] = useState<'save' | 'withdraw' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setStart(block.startedAt);
    setEnd(block.endedAt);
    setTask(block.larkTaskGuid ?? '');
    setReason(baseReason);
    setAttendees(block.attendeeIds ?? []);
  }, [requestId, block.startedAt, block.endedAt, block.larkTaskGuid, baseReason, block.attendeeIds]);

  const dirty =
    start !== block.startedAt ||
    end !== block.endedAt ||
    (task || '') !== (block.larkTaskGuid ?? '') ||
    reason !== baseReason ||
    !sameStringSet(attendees, block.attendeeIds ?? []);

  async function save() {
    if (!dirty) return;
    setBusy('save');
    setErr(null);
    try {
      await onPatch({
        id: requestId,
        requestedStart: start,
        requestedEnd: end,
        larkTaskGuid: task || null,
        taskSummary: taskSummaryFor(tasks, task, block.taskSummary),
        reason,
        attendeeIds: attendees,
      });
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
      await onWithdraw(requestId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Withdraw failed');
    } finally {
      setBusy(null);
    }
  }

  const duration = Math.max(0, end - start);

  return (
    <tr
      data-row-id={rowId}
      className={`et-row et-row-pending-edit${dirty ? ' et-row-dirty' : ''}${highlighted ? ' et-row-highlighted' : ''}`}
    >
      <td><KindBadge kind="pending" /></td>
      <td className="et-time-cell">
        <span className="et-times-inline">
          <TimePopover value={start} timeZone={timeZone} disabled={disabled} maxTime={end - 60_000} onChange={setStart} ariaLabel="Start" />
          <span className="et-times-sep">–</span>
          <TimePopover value={end} timeZone={timeZone} disabled={disabled} minTime={start + 60_000} onChange={setEnd} ariaLabel="End" />
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
        <div className="et-attendees">
          <AttendeePicker
            users={workspaceUsers ?? []}
            selected={attendees}
            disabled={disabled}
            excludeIds={selfId ? [selfId] : []}
            onChange={setAttendees}
            ariaLabel="Meeting attendees"
          />
        </div>
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell">
        {!disabled && (
          <span className="et-actions">
            <Button
              size="sm"
              variant="danger"
              icon={<X size={13} strokeWidth={2.2} />}
              onClick={withdraw}
              loading={busy === 'withdraw'}
              disabled={busy !== null}
            >
              Withdraw
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              loading={busy === 'save'}
              disabled={busy !== null || !dirty || reason.trim().length === 0}
            >
              {busy === 'save' ? 'Saving…' : 'Update'}
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Gap row: composer for a fresh manual-time request
// ---------------------------------------------------------------------------

function GapRow({ block, tasks, timeZone, disabled, preset, presetTick, onCreate, workspaceUsers, selfId, rowId, highlighted }: GapRowProps) {
  // Default to the WHOLE gap — the user narrows it in the time dropdowns. This
  // matches the "fill the gap, then trim" mental model and means a single click
  // logs the entire missing stretch.
  const defaultRange = (b: DayBlock): { startedAt: number; endedAt: number } => ({
    startedAt: b.startedAt,
    endedAt: b.endedAt,
  });
  const initial = preset ?? defaultRange(block);
  const [start, setStart] = useState(initial.startedAt);
  const [end, setEnd] = useState(initial.endedAt);
  const [task, setTask] = useState('');
  const [reason, setReason] = useState('');
  const [attendees, setAttendees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One idempotency key per request being composed: a retry after a lost
  // response (or a double click) re-sends the SAME key, so the server returns
  // the request it already created instead of filing a duplicate. A new key is
  // minted only once a request has gone through or the row is reset.
  const [clientUuid, setClientUuid] = useState(newClientUuid);

  // When the parent fires a click-to-fill (presetTick changes), snap to that preset.
  useEffect(() => {
    if (preset) {
      setStart(preset.startedAt);
      setEnd(preset.endedAt);
    }
  }, [presetTick]);

  // Reset only when this row now describes a different gap (new start). Not on
  // mount (that would discard a click-to-fill preset) and not when only the
  // end moves: today's trailing gap ends at "now", so its end changes on every
  // 15s refetch, and resetting then wiped whatever the user was typing.
  const gapStartRef = useRef(block.startedAt);
  useEffect(() => {
    if (gapStartRef.current === block.startedAt) return;
    gapStartRef.current = block.startedAt;
    const r = defaultRange(block);
    setStart(r.startedAt);
    setEnd(r.endedAt);
    setTask('');
    setReason('');
    setAttendees([]);
    setErr(null);
    setClientUuid(newClientUuid());
  }, [block.startedAt]);

  // The gap can also shrink (a timer started inside it): keep the draft, just
  // pull the selected range back inside the gap.
  useEffect(() => {
    setEnd((e) => Math.min(e, block.endedAt));
    setStart((st) => Math.min(st, block.endedAt));
  }, [block.endedAt]);

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
      await onCreate({
        clientUuid,
        requestedStart: start,
        requestedEnd: end,
        larkTaskGuid: task || null,
        taskSummary: taskSummaryFor(tasks, task),
        reason,
        attendeeIds: attendees,
      });
      // Reset for the next gap-fill on the same row.
      const r = defaultRange(block);
      setStart(r.startedAt);
      setEnd(r.endedAt);
      setTask('');
      setReason('');
      setAttendees([]);
      setClientUuid(newClientUuid());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr data-row-id={rowId} className={`et-row et-row-gap${highlighted ? ' et-row-highlighted' : ''}`}>
      <td><KindBadge kind="gap" /></td>
      <td className="et-time-cell">
        {disabled ? (
          <span className="tabular secondary">
            {fmtTime(block.startedAt, timeZone)} – {fmtTime(block.endedAt, timeZone)}
          </span>
        ) : (
          <span className="et-times-inline">
            <TimePopover
              value={start}
              timeZone={timeZone}
              minTime={block.startedAt}
              maxTime={Math.max(block.startedAt, end - 60_000)}
              onChange={setStart}
              ariaLabel="Start"
            />
            <span className="et-times-sep">–</span>
            <TimePopover
              value={end}
              timeZone={timeZone}
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
          <>
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
            <div className="et-attendees">
              <AttendeePicker
                users={workspaceUsers ?? []}
                selected={attendees}
                excludeIds={selfId ? [selfId] : []}
                onChange={setAttendees}
                ariaLabel="Meeting attendees"
              />
            </div>
          </>
        )}
        {err && <div className="et-row-err">{err}</div>}
      </td>
      <td className="et-action-cell">
        {!disabled && (
          <span className="et-actions">
            <Button
              size="sm"
              variant="primary"
              icon={<Send size={13} strokeWidth={2} />}
              onClick={submit}
              loading={busy}
              disabled={busy || !reason.trim() || duration <= 0}
            >
              {busy ? 'Sending…' : 'Send for approval'}
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Rejected row (read-only summary)
// ---------------------------------------------------------------------------

function RejectedRow({ rejected, timeZone, rowId, highlighted }: RejectedRowProps) {
  return (
    <tr data-row-id={rowId} className={`et-row entry-row-rejected${highlighted ? ' et-row-highlighted' : ''}`}>
      <td><KindBadge kind="rejected" /></td>
      <td className="et-time-cell tabular">
        {fmtTime(rejected.requestedStart, timeZone)} <span className="et-times-sep">–</span> {fmtTime(rejected.requestedEnd, timeZone)}
      </td>
      <td className="tabular secondary">{fmtDurationMs(rejected.requestedEnd - rejected.requestedStart)}</td>
      <td className="secondary">{rejected.taskSummary ?? rejected.larkTaskGuid ?? <span className="tertiary">—</span>}</td>
      <td>
        <div>{rejected.reason}</div>
        {rejected.decidedReason && (
          <div className="small tertiary et-review-note">
            <AlertCircle size={10} strokeWidth={2.2} /> Reviewer: {rejected.decidedReason}
          </div>
        )}
      </td>
      <td />
    </tr>
  );
}

// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: RowKind | 'rejected' | 'meeting' | 'removed' | 'excluded' }) {
  const label =
    kind === 'tracked' ? 'Tracked'
    : kind === 'removed' ? 'Removed'
    : kind === 'excluded' ? 'Excluded'
    : kind === 'meeting' ? 'Meeting'
    : kind === 'manual_approved' ? 'Manual'
    : kind === 'pending' ? 'Pending'
    : kind === 'rejected' ? 'Rejected'
    : 'Gap';
  const cls = kind === 'manual_approved' ? 'manual' : kind === 'excluded' ? 'removed' : kind;
  return <span className={`kind-chip kind-${cls}`}>{label}</span>;
}

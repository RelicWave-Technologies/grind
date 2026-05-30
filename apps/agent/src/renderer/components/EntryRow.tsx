import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Loader2, RotateCcw, AlertCircle } from 'lucide-react';

/**
 * EntryRow — the inline-editable row used by the Edit Time table. Polymorphic
 * across the four row classes (tracked-AUTO / approved-MANUAL / pending /
 * rejected / gap). Per-row state machine: idle → editing → saving → idle (or
 * error). Optimistic updates patch the dayInsight query cache on success.
 *
 * Each row carries a single colored stripe on its left edge:
 *   green  = on the books (tracked AUTO or approved MANUAL)
 *   yellow = pending (waiting for approver)
 *   red    = rejected
 *   none   = gap / Not Working
 */

export type RowKind = 'tracked' | 'manual_approved' | 'pending' | 'rejected' | 'gap';

export interface RowProps {
  kind: RowKind;
  /** Stable id used to scroll-into-view from a ribbon click. */
  rowId: string;
  /** When true, row briefly flashes (e.g. selected from the ribbon). */
  flashing?: boolean;
  startedAt: number;
  endedAt: number;
  isOpen?: boolean;
  /** For tracked rows: TimeEntry.id; for pending/rejected: ManualTimeRequest.id; for gap: undefined */
  refId?: string;
  larkTaskGuid: string | null;
  notes: string | null;
  /** Lark task choices for the picker. */
  tasks: Array<{ guid: string; summary: string }>;
  /** When kind === 'rejected': the approver's stated reason, if any. */
  decidedReason?: string | null;
  /** Day query key for cache invalidation. */
  dayQueryKey: readonly unknown[];
  /** Pull approver-row by clicking ribbon counterpart. */
  onSelectRow?: (rowId: string) => void;
  /**
   * When set on a gap row, applies a narrower start/end (e.g. ribbon click
   * snapped a 1h window inside a long gap) and auto-focuses the reason
   * input so the user can start typing. The `tick` field bumps on every
   * ribbon click so re-clicking the same spot still re-applies — pure
   * value-equality wouldn't trigger React effects.
   */
  presetOverride?: { startedAt: number; endedAt: number; tick: number } | null;
}

export default function EntryRow(props: RowProps) {
  const qc = useQueryClient();
  // The row's draft only re-syncs when the SERVER-side identity changes
  // (refetch, different row). Preset overrides apply via a separate effect
  // below so they don't fight the user's manual edits.
  const initial = useMemo(
    () => ({
      taskGuid: props.larkTaskGuid ?? '',
      notes: props.notes ?? '',
      startedAt: props.startedAt,
      endedAt: props.endedAt,
    }),
    [props.larkTaskGuid, props.notes, props.startedAt, props.endedAt],
  );
  const [draft, setDraft] = useState(initial);
  // Refetches happen every 5s on today (trailing gap's endedAt = now ticks
  // forward, the running entry's endedAt ticks forward). Without a guard,
  // those refetches would wipe a user's in-progress edits. So only re-sync
  // when the user has NO unsaved changes. The check uses the previous
  // `initial` snapshot — we keep it in a ref so dependency churn doesn't
  // trip the comparison.
  const lastInitialRef = useRef(initial);
  useEffect(() => {
    const prev = lastInitialRef.current;
    const draftMatchesPrev =
      draft.taskGuid === prev.taskGuid &&
      draft.notes === prev.notes &&
      draft.startedAt === prev.startedAt &&
      draft.endedAt === prev.endedAt;
    lastInitialRef.current = initial;
    if (draftMatchesPrev) setDraft(initial);
    // If the draft diverged from the last initial, the user has unsaved
    // edits — leave them alone.
  }, [initial, draft]);

  const reasonRef = useRef<HTMLInputElement>(null);
  // Apply a preset (ribbon-click → narrower start/end + focus reason) once
  // per tick. Subsequent user edits on start/end stick; we only fire on tick
  // changes, not on the existence of presetOverride.
  const lastTickRef = useRef<number>(-1);
  useEffect(() => {
    const p = props.presetOverride;
    if (!p) return;
    if (p.tick === lastTickRef.current) return;
    lastTickRef.current = p.tick;
    setDraft((d) => ({ ...d, startedAt: p.startedAt, endedAt: p.endedAt }));
    // Defer focus to the next paint so the input is mounted + visible after
    // any scroll-into-view that the flash effect triggered.
    requestAnimationFrame(() => reasonRef.current?.focus());
  }, [props.presetOverride]);

  const dirty =
    draft.taskGuid !== (props.larkTaskGuid ?? '') ||
    draft.notes !== (props.notes ?? '') ||
    draft.startedAt !== props.startedAt ||
    draft.endedAt !== props.endedAt;

  // Gap + pending rows let the user adjust the time range. Tracked rows
  // don't (start/end on tracked OS time is reserved for an M11 admin flow).
  const startMutable = props.kind === 'pending' || props.kind === 'gap';
  const endMutable = props.kind === 'pending' || props.kind === 'gap';
  const taskMutable = props.kind === 'tracked' || props.kind === 'manual_approved' || props.kind === 'pending' || props.kind === 'gap';
  const notesMutable = taskMutable;
  const submitLabel = props.kind === 'gap' ? 'Send to approver' : props.kind === 'pending' ? 'Save changes' : props.kind === 'rejected' ? 'Re-request' : 'Save';
  const submitDisabled = (() => {
    if (props.kind === 'rejected') return false; // Re-request always available
    if (!dirty) return true;
    if (props.kind === 'gap' && draft.notes.trim().length < 3) return true;
    if (notesMutable && draft.notes.length > 500) return true;
    if ((startMutable || endMutable) && !(draft.startedAt < draft.endedAt)) return true;
    return false;
  })();

  const saveTracked = useMutation({
    mutationFn: () => window.agent.timer.patchEntry({ id: props.refId!, larkTaskGuid: draft.taskGuid || null, notes: draft.notes || null }),
  });
  const savePending = useMutation({
    mutationFn: () =>
      window.agent.timeRequests.patch({
        id: props.refId!,
        larkTaskGuid: draft.taskGuid || null,
        taskSummary: props.tasks.find((t) => t.guid === draft.taskGuid)?.summary ?? null,
        reason: draft.notes,
        requestedStart: draft.startedAt,
        requestedEnd: draft.endedAt,
      }),
  });
  const createRequest = useMutation({
    mutationFn: () =>
      window.agent.timeRequests.create({
        requestedStart: draft.startedAt,
        requestedEnd: draft.endedAt,
        reason: draft.notes,
        larkTaskGuid: draft.taskGuid || null,
        taskSummary: props.tasks.find((t) => t.guid === draft.taskGuid)?.summary ?? null,
      }),
  });
  const cancelPending = useMutation({
    mutationFn: () => window.agent.timeRequests.cancel(props.refId!),
  });

  const anyPending = saveTracked.isPending || savePending.isPending || createRequest.isPending || cancelPending.isPending;
  const lastErr = saveTracked.data?.ok === false ? saveTracked.data.error
                : savePending.data?.ok === false ? savePending.data.error
                : createRequest.data?.ok === false ? createRequest.data.error
                : cancelPending.data?.ok === false ? cancelPending.data.error
                : null;

  function submit() {
    if (props.kind === 'tracked' || props.kind === 'manual_approved') {
      saveTracked.mutate(undefined, { onSuccess: (r) => r.ok && qc.invalidateQueries({ queryKey: props.dayQueryKey }) });
    } else if (props.kind === 'pending') {
      savePending.mutate(undefined, { onSuccess: (r) => r.ok && qc.invalidateQueries({ queryKey: props.dayQueryKey }) });
    } else if (props.kind === 'gap') {
      createRequest.mutate(undefined, { onSuccess: (r) => r.ok && qc.invalidateQueries({ queryKey: props.dayQueryKey }) });
    } else if (props.kind === 'rejected') {
      // Re-request → new POST with the same range + a chance to edit the reason.
      createRequest.mutate(undefined, { onSuccess: (r) => r.ok && qc.invalidateQueries({ queryKey: props.dayQueryKey }) });
    }
  }

  const rowCls =
    'et-row' +
    (props.kind === 'tracked' || props.kind === 'manual_approved' ? ' et-row-tracked' : '') +
    (props.kind === 'pending' ? ' et-row-pending' : '') +
    (props.kind === 'rejected' ? ' et-row-rejected' : '') +
    (props.kind === 'gap' ? ' et-row-gap' : '') +
    (props.flashing ? ' et-row-flash' : '');

  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (props.flashing && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [props.flashing]);

  const durMs = draft.endedAt - draft.startedAt;
  const dur = fmtDur(durMs);

  return (
    <tr ref={rowRef} className={rowCls} id={`row-${props.rowId}`} onClick={() => props.onSelectRow?.(props.rowId)}>
      <td>
        <TimeInput
          value={draft.startedAt}
          disabled={!startMutable}
          onChange={(t) => setDraft((d) => ({ ...d, startedAt: t }))}
        />
      </td>
      <td>
        {props.isOpen ? 'now' : <TimeInput value={draft.endedAt} disabled={!endMutable} onChange={(t) => setDraft((d) => ({ ...d, endedAt: t }))} />}
      </td>
      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--label-secondary)' }}>{dur}</td>
      <td>
        <TaskPicker
          tasks={props.tasks}
          value={draft.taskGuid}
          disabled={!taskMutable}
          onChange={(g) => setDraft((d) => ({ ...d, taskGuid: g }))}
        />
      </td>
      <td>
        <input
          ref={reasonRef}
          className="et-input"
          type="text"
          maxLength={500}
          placeholder={props.kind === 'gap' ? 'Reason (required to send)' : props.kind === 'pending' ? 'Reason' : 'Notes'}
          value={draft.notes}
          disabled={!notesMutable}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
        />
        {props.kind === 'rejected' && props.decidedReason && (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
            <AlertCircle size={11} style={{ verticalAlign: -2 }} /> Approver said: {props.decidedReason}
          </div>
        )}
        {lastErr && (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
            <AlertCircle size={11} style={{ verticalAlign: -2 }} /> {humanizeErr(lastErr)}
          </div>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {props.kind !== 'rejected' && !dirty ? null : (
          <button
            className={'btn ' + (props.kind === 'rejected' ? 'btn-soft' : 'btn-prominent') + ' et-row-btn no-drag'}
            onClick={(e) => { e.stopPropagation(); submit(); }}
            disabled={submitDisabled || anyPending}
            title={submitLabel}
          >
            {anyPending ? <Loader2 size={13} className="spin" /> : props.kind === 'rejected' ? <RotateCcw size={13} /> : <Check size={13} strokeWidth={2.5} />}
            {' '}
            {submitLabel}
          </button>
        )}
        {props.kind === 'pending' && (
          <button
            className="btn btn-ghost et-row-btn no-drag"
            onClick={(e) => { e.stopPropagation(); cancelPending.mutate(undefined, { onSuccess: (r) => r.ok && qc.invalidateQueries({ queryKey: props.dayQueryKey }) }); }}
            disabled={anyPending}
            style={{ marginLeft: 6 }}
            title="Cancel this request"
          >
            <X size={13} strokeWidth={2.5} /> Cancel
          </button>
        )}
      </td>
    </tr>
  );
}

function TimeInput({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (ms: number) => void }) {
  // Convert epoch ms → "HH:mm" in local TZ for the <input type="time">.
  const hhmm = useMemo(() => {
    const d = new Date(value);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [value]);
  return (
    <input
      type="time"
      className="et-input et-input-time"
      value={hhmm}
      disabled={disabled}
      step={60}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map((n) => parseInt(n, 10));
        const d = new Date(value);
        d.setHours(h ?? 0);
        d.setMinutes(m ?? 0);
        d.setSeconds(0);
        d.setMilliseconds(0);
        onChange(d.getTime());
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function TaskPicker({ tasks, value, disabled, onChange }: { tasks: Array<{ guid: string; summary: string }>; value: string; disabled: boolean; onChange: (g: string) => void }) {
  return (
    <select
      className="et-input et-input-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
    >
      <option value="">— Untracked —</option>
      {tasks.map((t) => (
        <option key={t.guid} value={t.guid}>{t.summary}</option>
      ))}
    </select>
  );
}

function fmtDur(ms: number): string {
  if (ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function humanizeErr(e: string): string {
  if (e === 'already_decided') return 'Already decided — refresh.';
  if (e === 'forbidden') return 'Not yours to edit.';
  if (e === 'not_found') return 'Gone — was it deleted?';
  if (e === 'invalid') return 'Invalid value.';
  if (e === 'duplicate') return 'Duplicate request.';
  if (e === 'invalid_range_or_no_approver') return 'No approver, or bad range.';
  return e.length > 80 ? e.slice(0, 77) + '…' : e;
}

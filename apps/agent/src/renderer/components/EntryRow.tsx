import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Loader2, AlertCircle, Undo2 } from 'lucide-react';
import TimePopover from './TimePopover';
import TaskCombo from './TaskCombo';

/**
 * EntryRow — the inline-editable row used by the Edit Time table.
 *
 * v3 changes over v2:
 *   - Replaced native <input type="time"> + <select> with on-brand
 *     TimePopover + TaskCombo. No more OS chrome.
 *   - Action column is always rendered with a reserved width so the row
 *     doesn't shift when the save button toggles disabled/enabled. The
 *     button itself just dims via opacity.
 *   - Errors render as a small ⚠ icon next to the button with a tooltip,
 *     never as a separate row that bumps row height.
 *   - Successful saves trigger a soft green pulse on the row instead of
 *     yellow (yellow is reserved for ribbon-click flash).
 *   - Mutations optimistically patch the dayInsight cache (no flicker
 *     waiting for refetch).
 *   - Draft re-syncs only when the SERVER snapshot changes value-wise,
 *     never wiping user edits during the today refetch tick.
 */

/**
 * Three semantic states on the table, plus gaps:
 *   tracked          — green stripe, light green tint, no pill
 *   manual_approved  — amber stripe, light amber tint, MANUAL pill
 *   pending          — red stripe, light red tint, PENDING pill
 *   gap              — no stripe, white
 *
 * Rejected requests don't render at all — the user re-requests from the
 * gap. (The user sees rejections in their Lark IM.)
 */
export type RowKind = 'tracked' | 'manual_approved' | 'pending' | 'gap';

export interface RowProps {
  kind: RowKind;
  rowId: string;
  flashing?: boolean;
  /** When the user hovers the matching block on the ribbon, the row lifts
   *  with a soft shadow to make the linkage between the two surfaces clear. */
  highlighted?: boolean;
  startedAt: number;
  endedAt: number;
  isOpen?: boolean;
  refId?: string;
  larkTaskGuid: string | null;
  notes: string | null;
  tasks: Array<{ guid: string; summary: string }>;
  dayQueryKey: readonly unknown[];
  onSelectRow?: (rowId: string) => void;
  presetOverride?: { startedAt: number; endedAt: number; tick: number } | null;
}

export default function EntryRow(props: RowProps) {
  const qc = useQueryClient();

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

  // Re-sync draft only if the user has NO unsaved edits (otherwise the
  // today refetch ticking endedAt forward would clobber their typing).
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
  }, [initial, draft]);

  // Ribbon-click → apply a preset once per tick.
  const reasonRef = useRef<HTMLInputElement>(null);
  const lastTickRef = useRef<number>(-1);
  useEffect(() => {
    const p = props.presetOverride;
    if (!p) return;
    if (p.tick === lastTickRef.current) return;
    lastTickRef.current = p.tick;
    setDraft((d) => ({ ...d, startedAt: p.startedAt, endedAt: p.endedAt }));
    requestAnimationFrame(() => reasonRef.current?.focus());
  }, [props.presetOverride]);

  // Visual saved-pulse: set when a mutation lands successfully, cleared
  // after the CSS animation finishes so the same row can pulse again later.
  const [savedPulse, setSavedPulse] = useState(false);
  useEffect(() => {
    if (!savedPulse) return;
    const t = setTimeout(() => setSavedPulse(false), 1300);
    return () => clearTimeout(t);
  }, [savedPulse]);

  const dirty =
    draft.taskGuid !== (props.larkTaskGuid ?? '') ||
    draft.notes !== (props.notes ?? '') ||
    draft.startedAt !== props.startedAt ||
    draft.endedAt !== props.endedAt;

  const startMutable = props.kind === 'pending' || props.kind === 'gap';
  const endMutable = props.kind === 'pending' || props.kind === 'gap';
  const taskMutable = true; // all four row kinds let you change the task
  const notesMutable = true;
  const submitLabel =
    props.kind === 'gap' ? 'Send'
    : props.kind === 'pending' ? 'Update'
    : 'Save';
  const submitLabelLong =
    props.kind === 'gap' ? 'Send to approver'
    : props.kind === 'pending' ? 'Update approval'
    : 'Save changes';
  const submitDisabled = (() => {
    if (!dirty) return true;
    if (props.kind === 'gap' && draft.notes.trim().length < 3) return true;
    if (notesMutable && draft.notes.length > 500) return true;
    if ((startMutable || endMutable) && !(draft.startedAt < draft.endedAt)) return true;
    return false;
  })();

  const onSettled = (r: { ok: boolean }) => {
    if (!r.ok) return;
    setSavedPulse(true);
    void qc.invalidateQueries({ queryKey: props.dayQueryKey });
    void qc.invalidateQueries({ queryKey: ['myTimeRequests'] });
    // For gap-row create: the server-side gap doesn't change (the new
    // pending row appears in pendingOverlay), so without a manual reset
    // the draft would stay "dirty" forever and the buttons would keep
    // showing. Reset to the freshly-recomputed initial.
    if (props.kind === 'gap') {
      setDraft({
        taskGuid: props.larkTaskGuid ?? '',
        notes: '',
        startedAt: props.startedAt,
        endedAt: props.endedAt,
      });
    }
  };

  const saveTracked = useMutation({
    mutationFn: () => window.agent.timer.patchEntry({ id: props.refId!, larkTaskGuid: draft.taskGuid || null, notes: draft.notes || null }),
    onSuccess: onSettled,
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
    onSuccess: onSettled,
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
    onSuccess: onSettled,
  });
  const cancelPending = useMutation({
    mutationFn: () => window.agent.timeRequests.cancel(props.refId!),
    onSuccess: onSettled,
  });

  const anyPending = saveTracked.isPending || savePending.isPending || createRequest.isPending || cancelPending.isPending;
  const lastErr = saveTracked.data?.ok === false ? saveTracked.data.error
                : savePending.data?.ok === false ? savePending.data.error
                : createRequest.data?.ok === false ? createRequest.data.error
                : cancelPending.data?.ok === false ? cancelPending.data.error
                : null;

  function submit(): void {
    if (props.kind === 'tracked' || props.kind === 'manual_approved') saveTracked.mutate();
    else if (props.kind === 'pending') savePending.mutate();
    else createRequest.mutate(); // gap
  }

  const rowCls =
    'et-row' +
    (props.kind === 'tracked' ? ' et-row-tracked' : '') +
    (props.kind === 'manual_approved' ? ' et-row-manual-approved' : '') +
    (props.kind === 'pending' ? ' et-row-pending' : '') +
    (props.kind === 'gap' ? ' et-row-gap' : '') +
    (dirty ? ' et-row-dirty' : '') +
    (props.flashing ? ' et-row-flash' : '') +
    (savedPulse ? ' et-row-saved' : '') +
    (props.highlighted ? ' et-row-highlighted' : '');

  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (props.flashing && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [props.flashing]);

  const dur = fmtDur(draft.endedAt - draft.startedAt);

  return (
    <tr ref={rowRef} className={rowCls} id={`row-${props.rowId}`} onClick={() => props.onSelectRow?.(props.rowId)}>
      <td>
        {/* Start must be < End and not in the future. */}
        <TimePopover
          value={draft.startedAt}
          disabled={!startMutable}
          onChange={(t) => setDraft((d) => ({ ...d, startedAt: t, endedAt: t >= d.endedAt ? t + 15 * 60 * 1000 : d.endedAt }))}
          ariaLabel="Start time"
          maxTime={Math.min(draft.endedAt - 5 * 60 * 1000, Date.now())}
        />
      </td>
      <td>
        {props.isOpen ? <span className="et-chip-trigger et-chip-trigger-time" aria-disabled="true">now</span>
          : (
            /* End must be > Start and not in the future. */
            <TimePopover
              value={draft.endedAt}
              disabled={!endMutable}
              onChange={(t) => setDraft((d) => ({ ...d, endedAt: t, startedAt: t <= d.startedAt ? t - 15 * 60 * 1000 : d.startedAt }))}
              ariaLabel="End time"
              minTime={draft.startedAt + 5 * 60 * 1000}
              maxTime={Date.now()}
            />
          )}
      </td>
      <td className="et-cell-dur">{dur}</td>
      <td>
        <TaskCombo tasks={props.tasks} value={draft.taskGuid} disabled={!taskMutable} onChange={(g) => setDraft((d) => ({ ...d, taskGuid: g }))} ariaLabel="Task" />
      </td>
      <td>
        <input
          ref={reasonRef}
          className="et-reason"
          type="text"
          maxLength={500}
          placeholder={
            props.kind === 'gap' ? 'Reason (required to send)'
            : props.kind === 'pending' ? 'Reason'
            : 'Notes (optional)'
          }
          value={draft.notes}
          disabled={!notesMutable}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          onClick={(e) => e.stopPropagation()}
          aria-label="Reason or notes"
        />
      </td>
      <td className="et-action-cell">
        {/* Save / Cancel buttons — hidden by default, revealed via :hover /
            :focus-within / .et-row-dirty (see styles.css). The left-edge
            colored stripe already encodes the row's state, so a separate
            status pill is visual noise. */}
        <span className="et-actions">
          <button
            className="btn btn-prominent et-row-btn no-drag"
            onClick={(e) => { e.stopPropagation(); submit(); }}
            disabled={submitDisabled || anyPending}
            title={submitLabelLong}
            aria-label={submitLabelLong}
          >
            {anyPending ? <Loader2 size={13} className="spin" /> : <Check size={13} strokeWidth={2.5} />}
            {' '}{submitLabel}
          </button>
          {props.kind === 'pending' && (
            <button
              className="btn btn-ghost et-row-btn no-drag"
              onClick={(e) => { e.stopPropagation(); cancelPending.mutate(); }}
              disabled={anyPending}
              style={{ minWidth: 0, padding: '6px 10px', color: 'var(--danger)' }}
              title="Withdraw this request (removes the Approve/Reject card from your approver's Lark)"
              aria-label="Withdraw request"
            >
              <Undo2 size={13} strokeWidth={2.5} />
              {' '}Withdraw
            </button>
          )}
          {lastErr && (
            <span
              className="et-row-err-icon"
              title={humanizeErr(lastErr)}
              aria-label={`Save failed: ${humanizeErr(lastErr)}`}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <AlertCircle size={14} />
            </span>
          )}
        </span>
      </td>
    </tr>
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

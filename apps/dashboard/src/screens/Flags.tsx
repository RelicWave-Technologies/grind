import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Check, X, AlertOctagon } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ActivityFlag, FlagResolution, FlagType } from '../lib/types';
import { fmtTime, fmtDayLabel } from '../lib/format';

interface ListResponse {
  flags: ActivityFlag[];
  scope: 'self' | 'team' | 'workspace';
}

const SCOPE_LABEL: Record<ListResponse['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const TAB_LABEL: Record<'OPEN' | 'RESOLVED', string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
};

const FLAG_LABEL: Record<FlagType, string> = {
  IMPOSSIBLE_RATE: 'Impossible typing rate',
  METRONOMIC: 'Metronomic typing',
  LINEAR_MOUSE: 'Linear mouse motion',
  SINGLE_CHANNEL: 'Single-channel input',
  JIGGLER: 'Mouse jiggler',
};

const FLAG_BLURB: Record<FlagType, string> = {
  IMPOSSIBLE_RATE: '>1100 keys/min — physically impossible. Likely macro or paste-spam.',
  METRONOMIC: 'Inter-keystroke intervals were unnaturally regular.',
  LINEAR_MOUSE: 'Mouse moved along a straight line at near-constant speed.',
  SINGLE_CHANNEL: 'All input came from one channel (keys-only or mouse-only) over a long window.',
  JIGGLER: 'Mouse moves without clicks/keys/app switches at a fixed cadence.',
};

/**
 * Anti-cheat review queue (MANAGER+). Resolved flags keep their reviewer
 * stamp + note as an audit trail. We never auto-delete time — the verdict
 * lands on a row; future hooks can drop the matching minutes when
 * resolution=TIME_INVALIDATED.
 */
export function FlagsScreen() {
  const [tab, setTab] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['admin', 'flags', tab],
    queryFn: () => api<ListResponse>(`/v1/admin/flags?status=${tab}`),
  });

  const resolve = useMutation({
    mutationFn: async (vars: { id: string; resolution: FlagResolution; note?: string }) =>
      api<{ id: string; status: 'RESOLVED'; resolution: FlagResolution; timeInvalidated: boolean }>(
        `/v1/admin/flags/${vars.id}/resolve`,
        { method: 'POST', json: { resolution: vars.resolution, note: vars.note } },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'flags'] }),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">Anti-cheat flags</h1>
          <p className="secondary page-sub">
            {q.data ? <span className="scope-chip">{SCOPE_LABEL[q.data.scope]}</span> : <span>Loading…</span>}
            {' · '}
            <span className="callout secondary">Content-free signals only. Verdicts are auditable.</span>
          </p>
        </div>

        <div className="tabs">
          {(['OPEN', 'RESOLVED'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab${t === tab ? ' is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading…</div>}
      {q.isError && (
        <div className="card empty empty-error">Couldn&apos;t load: {(q.error as Error).message}</div>
      )}

      {q.data && q.data.flags.length === 0 && (
        <div className="card empty">
          {tab === 'OPEN' ? 'No open flags in your scope — clean shop.' : 'No resolved flags yet.'}
        </div>
      )}

      {q.data && q.data.flags.length > 0 && (
        <div className="approvals-list">
          {q.data.flags.map((f) => (
            <FlagCard
              key={f.id}
              flag={f}
              busy={resolve.isPending && resolve.variables?.id === f.id}
              error={
                resolve.isError && resolve.variables?.id === f.id
                  ? (resolve.error as Error | ApiError).message
                  : null
              }
              onResolve={(resolution, note) => resolve.mutate({ id: f.id, resolution, note })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlagCard({
  flag,
  busy,
  error,
  onResolve,
}: {
  flag: ActivityFlag;
  busy: boolean;
  error: string | null;
  onResolve: (resolution: FlagResolution, note?: string) => void;
}) {
  const [composing, setComposing] = useState<null | FlagResolution>(null);
  const [note, setNote] = useState('');

  const start = new Date(flag.windowStart);
  const end = new Date(flag.windowEnd);
  const day = flag.windowStart.slice(0, 10);
  const isResolved = flag.status === 'RESOLVED';

  return (
    <article className={`approval-card status-${flag.status.toLowerCase()} flag-card flag-card-${flag.type.toLowerCase()}`}>
      <div className="approval-head">
        <div className="approval-who">
          <div className="avatar-sm" aria-hidden>
            {initials(flag.user.name)}
          </div>
          <div className="approval-meta">
            <div className="approval-name">{flag.user.name}</div>
            <div className="approval-email small secondary">{flag.user.email}</div>
          </div>
        </div>
        <div className={`flag-pill flag-pill-${flag.type.toLowerCase()}`}>
          {flag.type === 'IMPOSSIBLE_RATE' ? (
            <AlertOctagon size={11} strokeWidth={2.4} />
          ) : (
            <ShieldAlert size={11} strokeWidth={2.4} />
          )}
          <span>{FLAG_LABEL[flag.type]}</span>
          <span className="risk-score">+{flag.riskScore}</span>
        </div>
      </div>

      <div className="approval-body">
        <div className="approval-row">
          <span className="approval-label">Window</span>
          <span className="approval-value tabular">
            {fmtDayLabel(day)} · {fmtTime(start.getTime())} – {fmtTime(end.getTime())}
          </span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Pattern</span>
          <span className="approval-value">{FLAG_BLURB[flag.type]}</span>
        </div>
        {Object.keys(flag.evidence).length > 0 && (
          <div className="approval-row">
            <span className="approval-label">Evidence</span>
            <span className="approval-value flag-evidence">
              {Object.entries(flag.evidence).map(([k, v]) => (
                <span key={k} className="evidence-chip">
                  <span className="evidence-k">{k}</span>
                  <span className="evidence-v tabular">{typeof v === 'number' ? fmtEvidence(v) : String(v)}</span>
                </span>
              ))}
            </span>
          </div>
        )}
        {isResolved && (
          <div className="approval-row">
            <span className="approval-label">Verdict</span>
            <span className="approval-value">
              <span className={`status-pill status-resolved verdict-${flag.resolution?.toLowerCase()}`}>
                {flag.resolution === 'DISMISSED' && <Check size={11} strokeWidth={2.2} />}
                {flag.resolution === 'CONFIRMED' && <X size={11} strokeWidth={2.2} />}
                {flag.resolution === 'TIME_INVALIDATED' && <X size={11} strokeWidth={2.2} />}
                <span>{flag.resolution?.replace('_', ' ').toLowerCase()}</span>
              </span>
              {flag.resolvedBy && (
                <span className="small secondary">
                  {' '}
                  by {flag.resolvedBy.name}
                  {flag.resolvedAt && (
                    <>
                      {' on '}
                      {new Date(flag.resolvedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </>
                  )}
                </span>
              )}
            </span>
          </div>
        )}
        {flag.resolvedNote && (
          <div className="approval-row">
            <span className="approval-label">Reviewer note</span>
            <span className="approval-value">{flag.resolvedNote}</span>
          </div>
        )}
      </div>

      {error && <div className="approval-error">Failed: {error}</div>}

      {!isResolved && (
        <div className="approval-actions">
          {composing ? (
            <form
              className="reject-form"
              onSubmit={(e) => {
                e.preventDefault();
                onResolve(composing, note.trim() || undefined);
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder={composing === 'DISMISSED' ? 'Why is this legitimate?' : 'Notes (optional)'}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />
              <button type="button" className="btn-ghost" onClick={() => setComposing(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                className={composing === 'DISMISSED' ? 'btn-primary' : 'btn-danger'}
                disabled={busy}
              >
                {busy ? 'Saving…' : `Confirm ${composing === 'DISMISSED' ? 'dismiss' : 'cheat'}`}
              </button>
            </form>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={() => setComposing('DISMISSED')} disabled={busy}>
                <Check size={14} strokeWidth={2.2} />
                <span>Dismiss</span>
              </button>
              <button type="button" className="btn-danger" onClick={() => setComposing('CONFIRMED')} disabled={busy}>
                <X size={14} strokeWidth={2.2} />
                <span>Confirm cheat</span>
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function fmtEvidence(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  // Big or tiny → scientific; otherwise 2 dp.
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(2);
  return v.toFixed(2);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

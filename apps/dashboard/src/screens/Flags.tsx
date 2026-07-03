import './flags.css';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Check, X, AlertOctagon, ShieldCheck, Sparkles, Ban } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ActivityFlag, FlagResolution, FlagType } from '../lib/types';
import {
  Page,
  PageHeader,
  Tabs,
  Card,
  Identity,
  Avatar,
  Tag,
  Button,
  Field,
  Input,
  Banner,
  EmptyState,
  SkeletonTable,
} from '../ui';
import type { Status } from '../ui';
import { fmtTime, fmtDayLabel, fmtDurationMs } from '../lib/format';

interface ListResponse {
  flags: ActivityFlag[];
  scope: 'self' | 'team' | 'workspace';
}

const SCOPE_LABEL: Record<ListResponse['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
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

/** Risk at/above this score reads as HIGH and earns the danger taxonomy. */
const HIGH_RISK = 40;

/** Map an open flag's risk score onto the fixed status taxonomy. */
function riskStatus(score: number, isResolved: boolean): Status {
  if (isResolved) return 'neutral';
  return score >= HIGH_RISK ? 'danger' : 'warn';
}

/** Map a resolution verdict onto the taxonomy: dismissed = legitimate (success). */
function verdictStatus(resolution: FlagResolution): Status {
  return resolution === 'DISMISSED' ? 'success' : 'danger';
}

/**
 * Anti-cheat review queue (MANAGER+), composed entirely from the shared kit
 * ("Quiet Datasheet"). Each flag is a Card: an Identity ←→ a mono risk readout,
 * the flag TYPE as a status Tag, a mono Window row, the AI read in an info
 * Banner, mono Evidence chips, and inline Dismiss / Confirm-cheat actions.
 * Resolved flags carry a verdict Tag + audit stamp. Risk severity rides the
 * fixed status taxonomy (danger ≥ threshold, warn below, neutral once resolved);
 * we never auto-delete time — the verdict lands on a row. Presentation only.
 */
export function FlagsScreen() {
  const [tab, setTab] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [lastInvalidation, setLastInvalidation] = useState<null | { id: string; invalidatedMs: number }>(null);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['admin', 'flags', tab],
    queryFn: () => api<ListResponse>(`/v1/admin/flags?status=${tab}`),
  });

  const resolve = useMutation({
    mutationFn: async (vars: { id: string; resolution: FlagResolution; note?: string }) =>
      api<{ id: string; status: 'RESOLVED'; resolution: FlagResolution; timeInvalidated: boolean; invalidatedMs: number }>(
        `/v1/admin/flags/${vars.id}/resolve`,
        { method: 'POST', json: { resolution: vars.resolution, note: vars.note } },
      ),
    onSuccess: (data) => {
      setLastInvalidation(data.timeInvalidated ? { id: data.id, invalidatedMs: data.invalidatedMs } : null);
      qc.invalidateQueries({ queryKey: ['admin', 'flags'] });
    },
  });

  const count = q.data?.flags.length ?? 0;

  return (
    <Page>
      <PageHeader
        eyebrow={`${q.data ? SCOPE_LABEL[q.data.scope] : 'Loading'} · Anti-cheat`}
        title="Risk flags"
        subtitle="Content-free behavioural signals only. Every verdict is auditable — nothing is deleted automatically."
        tabs={
          <Tabs
            aria-label="Flag status"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'OPEN', label: tab === 'OPEN' && count > 0 ? `Open · ${count}` : 'Open' },
              {
                value: 'RESOLVED',
                label: tab === 'RESOLVED' && count > 0 ? `Resolved · ${count}` : 'Resolved',
              },
            ]}
          />
        }
      />

      {q.isLoading && (
        <Card>
          <SkeletonTable rows={4} />
        </Card>
      )}

      {q.isError && (
        <Banner status="danger">Couldn&apos;t load flags — {(q.error as Error).message}</Banner>
      )}

      {lastInvalidation && (
        <Banner status="warn">
          Time invalidated: {fmtDurationMs(lastInvalidation.invalidatedMs)} excluded from reports and KPIs.
        </Banner>
      )}

      {q.data && q.data.flags.length === 0 && (
        <EmptyState
          icon={<ShieldCheck size={26} strokeWidth={1.8} />}
          title={tab === 'OPEN' ? 'Clean shop' : 'Nothing resolved yet'}
          description={
            tab === 'OPEN'
              ? 'No open flags in your scope. New behavioural anomalies will surface here for review.'
              : 'Resolved flags and their audit trail will appear here once you triage the queue.'
          }
        />
      )}

      {q.data && q.data.flags.length > 0 && (
        <div className="flg-queue">
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
    </Page>
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
  const sev = riskStatus(flag.riskScore, isResolved);
  const evidence = Object.entries(flag.evidence);

  return (
    <Card>
      {/* Top: who ←→ risk readout */}
      <div className="flg-top">
        <Identity
          name={flag.user.name}
          subtitle={flag.user.email}
          avatar={<Avatar name={flag.user.name} src={flag.user.avatarUrl ?? undefined} size={40} />}
        />
        <div className="flg-risk">
          <span className="ui-t-eyebrow flg-risk__cap">Risk</span>
          <span className="ui-t-num flg-risk__num">{flag.riskScore}</span>
          <Tag status={sev}>{sev === 'danger' ? 'High' : sev === 'warn' ? 'Elevated' : 'Closed'}</Tag>
        </div>
      </div>

      {/* Flag type */}
      <div className="flg-type">
        <Tag status={sev}>
          {flag.type === 'IMPOSSIBLE_RATE' ? (
            <AlertOctagon size={12} strokeWidth={2.2} />
          ) : (
            <ShieldAlert size={12} strokeWidth={2.2} />
          )}
          {FLAG_LABEL[flag.type]}
        </Tag>
      </div>

      {/* Window */}
      <div className="flg-def">
        <span className="ui-t-eyebrow">Window</span>
        <span className="ui-mono flg-def__val">
          {fmtDayLabel(day)} · {fmtTime(start.getTime())} – {fmtTime(end.getTime())}
        </span>
      </div>

      {/* AI read / pattern */}
      {flag.explanation?.headline ? (
        <Banner status="info">
          <span className="flg-ai__cap">
            <Sparkles size={11} strokeWidth={2.2} /> AI read
          </span>
          <span className="ui-t-body flg-ai__head">{flag.explanation.headline}</span>
          {flag.explanation.detail && (
            <span className="ui-t-small flg-ai__detail">{flag.explanation.detail}</span>
          )}
        </Banner>
      ) : (
        <div className="flg-def">
          <span className="ui-t-eyebrow">Pattern</span>
          <span className="ui-t-body flg-def__val">{FLAG_BLURB[flag.type]}</span>
        </div>
      )}

      {/* Evidence chips */}
      {evidence.length > 0 && (
        <div className="flg-def">
          <span className="ui-t-eyebrow">Evidence</span>
          <div className="flg-chips">
            {evidence.map(([k, v]) => (
              <Tag key={k} mono>
                {k} {typeof v === 'number' ? fmtEvidence(v) : String(v)}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {/* Note (resolved or rejected with a reviewer note) */}
      {flag.resolvedNote && (
        <div className="flg-def">
          <span className="ui-t-eyebrow">Note</span>
          <span className="ui-t-body flg-def__val">{flag.resolvedNote}</span>
        </div>
      )}

      {/* Resolved: verdict + audit stamp */}
      {isResolved && flag.resolution && (
        <div className="flg-verdict">
          <Tag status={verdictStatus(flag.resolution)}>
            {flag.resolution === 'DISMISSED' ? (
              <Check size={12} strokeWidth={2.2} />
            ) : (
              <X size={12} strokeWidth={2.2} />
            )}
            {flag.resolution.replace('_', ' ').toLowerCase()}
          </Tag>
          {flag.resolvedBy && (
            <span className="ui-mono ui-t-small flg-stamp">
              by {flag.resolvedBy.name}
              {flag.resolvedAt &&
                ` · ${new Date(flag.resolvedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}`}
            </span>
          )}
        </div>
      )}

      {/* Per-card error */}
      {error && <Banner status="danger">Failed — {error}</Banner>}

      {/* Open: inline triage actions */}
      {!isResolved &&
        (composing ? (
          <form
            className="flg-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (composing === 'TIME_INVALIDATED' && !note.trim()) return;
              onResolve(composing, note.trim() || undefined);
            }}
          >
            <Field
              className="flg-form__field"
              label={
                composing === 'DISMISSED'
                  ? 'Why is this legitimate?'
                  : composing === 'TIME_INVALIDATED'
                    ? 'Why should this time be excluded?'
                    : 'Notes (optional)'
              }
            >
              <Input
                autoFocus
                placeholder={
                  composing === 'DISMISSED'
                    ? 'Why is this legitimate?'
                    : composing === 'TIME_INVALIDATED'
                      ? 'Required audit note'
                      : 'Notes (optional)'
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                required={composing === 'TIME_INVALIDATED'}
              />
            </Field>
            <div className="flg-actions">
              <Button type="button" variant="ghost" onClick={() => setComposing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={composing === 'DISMISSED' ? 'secondary' : 'danger'}
                loading={busy}
              >
                {composing === 'DISMISSED'
                  ? 'Confirm dismiss'
                  : composing === 'TIME_INVALIDATED'
                    ? 'Invalidate time'
                    : 'Confirm cheat'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flg-actions">
            <Button
              variant="secondary"
              icon={<Check size={14} strokeWidth={2.1} />}
              onClick={() => {
                setNote('');
                setComposing('DISMISSED');
              }}
              disabled={busy}
            >
              Dismiss
            </Button>
            <Button
              variant="danger"
              icon={<X size={14} strokeWidth={2.1} />}
              onClick={() => {
                setNote('');
                setComposing('CONFIRMED');
              }}
              disabled={busy}
            >
              Confirm cheat
            </Button>
            <Button
              variant="danger"
              icon={<Ban size={14} strokeWidth={2.1} />}
              onClick={() => {
                setNote('');
                setComposing('TIME_INVALIDATED');
              }}
              disabled={busy}
            >
              Invalidate time
            </Button>
          </div>
        ))}
    </Card>
  );
}

function fmtEvidence(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  // Big or tiny → scientific; otherwise 2 dp.
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(2);
  return v.toFixed(2);
}

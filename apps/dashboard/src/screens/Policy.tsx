import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Loader2, Check } from 'lucide-react';
import { api } from '../lib/api';

/**
 * /policy — ADMIN editor for the workspace capture policy (M14).
 *
 * Three flags along a strictness gradient:
 *   captureApps   — which app is in focus (e.g. "Chrome")
 *   captureTitles — the foreground window title
 *   captureUrls   — the browser URL (true content)
 *
 * Plus a `retentionDaysScreenshots` knob driving the nightly purge.
 * The server is also the privacy enforcer: even if an agent ships
 * titles/URLs while the policy is OFF, ingestion scrubs them before
 * they hit the database. This screen exists so admins can see + flip
 * the flag from one calm surface, not so we trust the client.
 */

interface WorkspacePolicy {
  workspaceId: string;
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
  retentionDaysScreenshots: number;
  createdAt: string;
  updatedAt: string;
}

export function PolicyScreen() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspace-policy'],
    queryFn: () => api<WorkspacePolicy>('/v1/admin/workspace-policy'),
  });

  const [draft, setDraft] = useState<WorkspacePolicy | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data);
  }, [q.data, draft]);

  const m = useMutation({
    mutationFn: (patch: Partial<WorkspacePolicy>) =>
      api<WorkspacePolicy>('/v1/admin/workspace-policy', { method: 'PATCH', json: patch }),
    onSuccess: (next) => {
      qc.setQueryData(['workspace-policy'], next);
      setDraft(next);
    },
  });

  if (q.isLoading || !draft) {
    return <div className="page page-wide"><div className="card empty">Loading policy…</div></div>;
  }
  if (q.isError) {
    return (
      <div className="page page-wide">
        <div className="card empty empty-error">
          Couldn&apos;t load policy: {(q.error as Error).message}
        </div>
      </div>
    );
  }

  const dirty =
    draft.captureApps !== q.data?.captureApps ||
    draft.captureTitles !== q.data?.captureTitles ||
    draft.captureUrls !== q.data?.captureUrls ||
    draft.retentionDaysScreenshots !== q.data?.retentionDaysScreenshots;

  async function save() {
    if (!draft) return;
    await m.mutateAsync({
      captureApps: draft.captureApps,
      captureTitles: draft.captureTitles,
      captureUrls: draft.captureUrls,
      retentionDaysScreenshots: draft.retentionDaysScreenshots,
    });
  }

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={20} strokeWidth={1.8} /> Workspace policy
          </h1>
          <p className="secondary page-sub">
            Capture rules apply to everyone in this workspace. Defaults are off; flip each line on only if you need it.
          </p>
        </div>
        <div className="day-controls">
          <button
            type="button"
            className="btn btn-prominent"
            onClick={save}
            disabled={!dirty || m.isPending}
          >
            {m.isPending ? <Loader2 size={14} className="spin" /> : m.isSuccess && !dirty ? <Check size={14} /> : null}
            {m.isPending ? 'Saving…' : m.isSuccess && !dirty ? 'Saved' : 'Save policy'}
          </button>
        </div>
      </header>

      <section className="card" style={{ padding: 'var(--sp-6) var(--sp-7)' }}>
        <PolicyRow
          title="Capture which app is in focus"
          help="Stores the running application's name + bundle ID per minute (e.g. “Google Chrome / com.google.Chrome”). Required for the apps timeline on My Day."
          checked={draft.captureApps}
          onChange={(v) => setDraft({ ...draft, captureApps: v })}
        />
        <PolicyRow
          title="Capture window titles"
          help="Adds the foreground window's title (the document, tab, or message name). Titles can leak doc/customer names — turn on with care."
          checked={draft.captureTitles}
          onChange={(v) => setDraft({ ...draft, captureTitles: v })}
          disabled={!draft.captureApps}
          disabledHint="Enable “Capture which app is in focus” first."
        />
        <PolicyRow
          title="Capture browser URLs"
          help="Adds the URL of the current tab in Chrome/Safari. Treated as content — the strictest flag. Keep off unless you have a documented reason."
          checked={draft.captureUrls}
          onChange={(v) => setDraft({ ...draft, captureUrls: v })}
          disabled={!draft.captureApps}
          disabledHint="Enable “Capture which app is in focus” first."
        />

        <div className="policy-row">
          <div className="policy-row-text">
            <div className="policy-row-title">Screenshot retention</div>
            <div className="policy-row-help">
              Screenshots older than this are purged nightly. Set to 0 to keep forever (not recommended).
            </div>
          </div>
          <div className="policy-row-control">
            <input
              type="number"
              min={0}
              max={3650}
              value={draft.retentionDaysScreenshots}
              onChange={(e) =>
                setDraft({ ...draft, retentionDaysScreenshots: Math.max(0, Math.min(3650, Number(e.target.value) || 0)) })
              }
              className="policy-input"
            />
            <span className="small secondary">days</span>
          </div>
        </div>
      </section>

      {m.isError && (
        <div className="card empty empty-error" style={{ marginTop: 'var(--sp-3)' }}>
          Couldn&apos;t save: {(m.error as Error).message}
        </div>
      )}
    </div>
  );
}

function PolicyRow({
  title,
  help,
  checked,
  onChange,
  disabled,
  disabledHint,
}: {
  title: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const effective = disabled ? false : checked;
  return (
    <div className={`policy-row${disabled ? ' is-disabled' : ''}`}>
      <div className="policy-row-text">
        <div className="policy-row-title">{title}</div>
        <div className="policy-row-help">{help}</div>
        {disabled && disabledHint && <div className="policy-row-disabled-hint">{disabledHint}</div>}
      </div>
      <div className="policy-row-control">
        <label className="policy-toggle">
          <input
            type="checkbox"
            checked={effective}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="policy-toggle-track" aria-hidden />
        </label>
      </div>
    </div>
  );
}

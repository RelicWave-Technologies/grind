import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../lib/api';
import {
  Page,
  PageHeader,
  Card,
  List,
  ListRow,
  Field,
  Input,
  Toggle,
  Tag,
  Button,
  Banner,
  EmptyState,
  Toolbar,
  Skeleton,
} from '../ui';
import type { Rail } from '../ui';
import './policy.css';

/**
 * /policy — ADMIN editor for the workspace capture policy (M14).
 *
 * Composed entirely from the shared "Quiet Datasheet" kit: a PageHeader carries
 * the dirty-state Tag + primary Save in its Toolbar; each settings GROUP is a
 * Card hosting a List of rows, one Toggle per capture flag; retention is a
 * number Field. The capture flags carry a status rail along the strictness
 * gradient — success → warn → danger maps the §2 taxonomy onto "least → most
 * sensitive", so the privacy weight is legible without bespoke colour.
 *
 * Three flags along that gradient:
 *   captureApps   — which app is in focus (e.g. "Chrome")
 *   captureTitles — the foreground window title
 *   captureUrls   — the browser URL (true content)
 *
 * Plus a `retentionDaysScreenshots` knob driving the nightly purge.
 * The server is also the privacy enforcer: even if an agent ships
 * titles/URLs while the policy is OFF, ingestion scrubs them before
 * they hit the database. This screen exists so admins can see + flip
 * the flag from one calm surface, not so we trust the client.
 *
 * Behaviour, queries, and the route/export contract are unchanged — the
 * useQuery / PATCH useMutation / draft seeding / dirty calc / clamp all match
 * the prior version exactly. Presentation only.
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

  const header = (
    <PageHeader
      eyebrow="Admin · Privacy"
      title="Workspace policy"
      subtitle="Capture rules apply to everyone in this workspace. Defaults are off — flip each line on only if you genuinely need it."
    />
  );

  if (q.isLoading || !draft) {
    return (
      <Page>
        {header}
        <div className="pol-body">
          <Card title="Capture">
            <List>
              {[0, 1, 2].map((i) => (
                <ListRow
                  key={i}
                  title={<Skeleton w={220} h={14} />}
                  subtitle={<Skeleton w={320} h={12} />}
                  trailing={<Skeleton w={36} h={20} radius={999} />}
                />
              ))}
            </List>
          </Card>
        </div>
      </Page>
    );
  }
  if (q.isError) {
    return (
      <Page>
        {header}
        <EmptyState
          tone="danger"
          title="Couldn’t load policy"
          description={(q.error as Error).message}
        />
      </Page>
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

  const saved = m.isSuccess && !dirty;

  return (
    <Page>
      <PageHeader
        eyebrow="Admin · Privacy"
        title="Workspace policy"
        subtitle="Capture rules apply to everyone in this workspace. Defaults are off — flip each line on only if you genuinely need it."
        actions={
          <Toolbar>
            <Tag status={dirty ? 'warn' : 'success'} dot>
              {dirty ? 'Unsaved changes' : 'All saved'}
            </Tag>
            <Button
              variant="primary"
              onClick={save}
              disabled={!dirty || m.isPending}
              loading={m.isPending}
              icon={saved ? <Check size={14} strokeWidth={2.6} /> : undefined}
            >
              {m.isPending ? 'Saving…' : saved ? 'Saved' : 'Save policy'}
            </Button>
          </Toolbar>
        }
      />

      <div className="pol-body">
        {/* ── Capture group — one List, a Toggle per flag, strictness rail ─── */}
        <Card title="Capture" action={<Tag mono>3 flags</Tag>}>
          <List>
            <PolicyRow
              sensitivity="low"
              title="Capture which app is in focus"
              help="Stores the running application’s name + bundle ID per minute (e.g. “Google Chrome / com.google.Chrome”). Required for the apps timeline on My Day."
              checked={draft.captureApps}
              onChange={(v) => setDraft({ ...draft, captureApps: v })}
            />
            <PolicyRow
              sensitivity="medium"
              title="Capture window titles"
              help="Adds the foreground window’s title (the document, tab, or message name). Titles can leak doc/customer names — turn on with care."
              checked={draft.captureTitles}
              onChange={(v) => setDraft({ ...draft, captureTitles: v })}
              disabled={!draft.captureApps}
              disabledHint="Enable “Capture which app is in focus” first."
            />
            <PolicyRow
              sensitivity="high"
              title="Capture browser URLs"
              help="Adds the URL of the current tab in Chrome/Safari. Treated as content — the strictest flag. Keep off unless you have a documented reason."
              checked={draft.captureUrls}
              onChange={(v) => setDraft({ ...draft, captureUrls: v })}
              disabled={!draft.captureApps}
              disabledHint="Enable “Capture which app is in focus” first."
            />
          </List>
        </Card>

        {/* ── Retention group — a single number Field ───────────────────────── */}
        <Card title="Retention" action={<Tag>Nightly purge</Tag>}>
          <Field
            label="Screenshot retention"
            hint="Screenshots older than this are purged nightly. Set to 0 to keep forever (not recommended)."
          >
            <div className="pol-field-control">
              <Input
                type="number"
                min={0}
                max={3650}
                value={draft.retentionDaysScreenshots}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    retentionDaysScreenshots: Math.max(
                      0,
                      Math.min(3650, Number(e.target.value) || 0),
                    ),
                  })
                }
              />
              <span className="ui-t-eyebrow">days</span>
            </div>
          </Field>
        </Card>

        {m.isError && (
          <Banner status="danger">Couldn’t save: {(m.error as Error).message}</Banner>
        )}
      </div>
    </Page>
  );
}

const SENSITIVITY_RAIL: Record<'low' | 'medium' | 'high', Rail> = {
  low: 'success',
  medium: 'warn',
  high: 'danger',
};

function PolicyRow({
  title,
  help,
  checked,
  onChange,
  disabled,
  disabledHint,
  sensitivity,
}: {
  title: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledHint?: string;
  sensitivity: 'low' | 'medium' | 'high';
}) {
  const effective = disabled ? false : checked;
  return (
    <ListRow
      rail={SENSITIVITY_RAIL[sensitivity]}
      title={title}
      subtitle={disabled && disabledHint ? `${help} ${disabledHint}` : help}
      trailing={
        <Toggle checked={effective} disabled={disabled} onChange={onChange} />
      }
    />
  );
}

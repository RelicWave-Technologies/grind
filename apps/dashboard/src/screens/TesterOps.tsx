import './testerops.css';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, RefreshCw, Send, PlayCircle } from 'lucide-react';
import { api } from '../lib/api';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  Page,
  PageHeader,
  Select,
  Stat,
  StatRow,
  Tag,
  Textarea,
  Toggle,
  Toolbar,
} from '../ui';

interface TesterOpsConfig {
  enabled: boolean;
  chatId: string | null;
  timezone: string;
  pingTimes: string[];
  passiveIssueDetectionEnabled: boolean;
}

interface AiPolicy {
  provider: 'OPENROUTER' | 'DEEPSEEK';
  model: string | null;
  promptVersion: string;
  highConfidenceThreshold: number;
  mediumConfidenceThreshold: number;
}

interface Summary {
  usage: {
    totals: { testers: number; trackingNow: number; silent: number };
    testers: Array<{ userId: string; name: string; trackedMinutes: number; screenshots: number; agentState: string }>;
  };
  queues: { issues: number; candidates: number };
  reminders: Array<{ id: string; scheduledFor: string; sentAt: string | null }>;
  aiRuns: Array<{ id: string; task: string; provider: string; model: string; error: string | null; createdAt: string }>;
}

interface IssueResponse {
  issues: Array<{
    id: string;
    status: 'CANDIDATE' | 'OPEN' | 'RESOLVED' | 'DISMISSED';
    severity: string;
    confidence: number;
    summary: string;
    sourceMessageText: string | null;
    createdAt: string;
  }>;
}

interface KnowledgeResponse {
  sources: Array<{
    id: string;
    title: string;
    token: string;
    url: string | null;
    enabled: boolean;
    lastFetchedAt: string | null;
    lastError: string | null;
    _count: { chunks: number };
  }>;
}

export function TesterOpsScreen() {
  const qc = useQueryClient();
  const configQ = useQuery({ queryKey: ['tester-ops', 'config'], queryFn: () => api<TesterOpsConfig>('/v1/admin/tester-ops/config') });
  const policyQ = useQuery({ queryKey: ['tester-ops', 'ai-policy'], queryFn: () => api<AiPolicy>('/v1/admin/tester-ops/ai-policy') });
  const summaryQ = useQuery({ queryKey: ['tester-ops', 'summary'], queryFn: () => api<Summary>('/v1/admin/tester-ops/summary'), refetchInterval: 30_000 });
  const issuesQ = useQuery({ queryKey: ['tester-ops', 'issues'], queryFn: () => api<IssueResponse>('/v1/admin/tester-ops/issues') });
  const knowledgeQ = useQuery({ queryKey: ['tester-ops', 'knowledge'], queryFn: () => api<KnowledgeResponse>('/v1/admin/tester-ops/knowledge-sources') });

  const [sourceDraft, setSourceDraft] = useState({ title: '', token: '', url: '' });
  const [replayText, setReplayText] = useState('@Timo what should I test today?');

  const saveConfig = useMutation({
    mutationFn: (patch: Partial<TesterOpsConfig>) => api('/v1/admin/tester-ops/config', { method: 'PUT', json: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops'] }),
  });
  const savePolicy = useMutation({
    mutationFn: (patch: Partial<AiPolicy>) => api('/v1/admin/tester-ops/ai-policy', { method: 'PUT', json: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops'] }),
  });
  const patchIssue = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/v1/admin/tester-ops/issues/${id}`, { method: 'PATCH', json: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops'] }),
  });
  const sendNow = useMutation({
    mutationFn: () => api('/v1/admin/tester-ops/reminders/send-now', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops'] }),
  });
  const saveSource = useMutation({
    mutationFn: () => api('/v1/admin/tester-ops/knowledge-sources', { method: 'PUT', json: { sources: [{ ...sourceDraft, url: sourceDraft.url || null, enabled: true }] } }),
    onSuccess: () => {
      setSourceDraft({ title: '', token: '', url: '' });
      qc.invalidateQueries({ queryKey: ['tester-ops', 'knowledge'] });
    },
  });
  const refreshSource = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/tester-ops/knowledge-sources/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops', 'knowledge'] }),
  });
  const replay = useMutation({
    mutationFn: () => api('/v1/admin/tester-ops/ai/replay', { method: 'POST', json: { messageText: replayText, directMention: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tester-ops'] }),
  });

  const cfg = configQ.data;
  const policy = policyQ.data;
  const summary = summaryQ.data;
  const openIssues = useMemo(() => (issuesQ.data?.issues ?? []).filter((i) => i.status === 'OPEN'), [issuesQ.data]);
  const candidates = useMemo(() => (issuesQ.data?.issues ?? []).filter((i) => i.status === 'CANDIDATE'), [issuesQ.data]);

  return (
    <Page>
      <PageHeader
        eyebrow="TESTER OPS"
        title="Timo AI tester bot"
        subtitle="Controlled Lark group monitor with contextual AI routing, local doc cache, and audit trails."
        actions={
          <Toolbar>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={15} />} onClick={() => qc.invalidateQueries({ queryKey: ['tester-ops'] })}>
              Refresh
            </Button>
            <Button size="sm" icon={<Send size={15} />} onClick={() => sendNow.mutate()} disabled={sendNow.isPending || !cfg?.chatId}>
              Send status
            </Button>
          </Toolbar>
        }
      />

      {(configQ.isError || policyQ.isError || summaryQ.isError) && (
        <Banner status="danger">Tester Ops could not load. Check API health and migration state.</Banner>
      )}

      <div className="tops-grid">
        <Card variant="flush" className="ui-rise-1">
          <StatRow>
            <Stat label="Tracking now" value={summary?.usage.totals.trackingNow ?? 0} unit={`/ ${summary?.usage.totals.testers ?? 0}`} hint="tester agents online" />
            <Stat label="Silent today" value={summary?.usage.totals.silent ?? 0} hint="no time or screenshots yet" />
            <Stat label="Open issues" value={summary?.queues.issues ?? 0} hint="logged by AI brain" />
            <Stat label="Candidates" value={summary?.queues.candidates ?? 0} hint="low confidence queue" />
          </StatRow>
        </Card>

        <div className="tops-columns">
          <Card title="Bot config" action={cfg?.enabled ? <Tag status="success">Enabled</Tag> : <Tag status="neutral">Disabled</Tag>}>
            {cfg && (
              <div className="tops-form">
                <Field label="Enable bot harness">
                  <Toggle checked={cfg.enabled} onChange={(enabled) => saveConfig.mutate({ enabled })} />
                </Field>
                <Field label="Passive issue detection">
                  <Toggle checked={cfg.passiveIssueDetectionEnabled} onChange={(passiveIssueDetectionEnabled) => saveConfig.mutate({ passiveIssueDetectionEnabled })} />
                </Field>
                <Field label="Group chat ID">
                  <Input defaultValue={cfg.chatId ?? ''} onBlur={(e) => saveConfig.mutate({ chatId: e.currentTarget.value || null })} />
                </Field>
                <Field label="Timezone">
                  <Input defaultValue={cfg.timezone} onBlur={(e) => saveConfig.mutate({ timezone: e.currentTarget.value || 'UTC' })} />
                </Field>
                <Field label="Status times">
                  <Input defaultValue={cfg.pingTimes.join(', ')} onBlur={(e) => saveConfig.mutate({ pingTimes: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                </Field>
              </div>
            )}
          </Card>

          <Card title="AI policy" action={<Tag status={policy?.model ? 'success' : 'warn'}>{policy?.model ? 'Model set' : 'Missing model'}</Tag>}>
            {policy && (
              <div className="tops-form">
                <Field label="Provider">
                  <Select value={policy.provider} onChange={(e) => savePolicy.mutate({ provider: e.currentTarget.value as AiPolicy['provider'] })}>
                    <option value="OPENROUTER">OpenRouter</option>
                    <option value="DEEPSEEK">DeepSeek</option>
                  </Select>
                </Field>
                <Field label="Model">
                  <Input defaultValue={policy.model ?? ''} onBlur={(e) => savePolicy.mutate({ model: e.currentTarget.value || null })} placeholder="provider/model-id" />
                </Field>
                <Field label="Prompt version">
                  <Input defaultValue={policy.promptVersion} onBlur={(e) => savePolicy.mutate({ promptVersion: e.currentTarget.value })} />
                </Field>
              </div>
            )}
          </Card>
        </div>

        <div className="tops-columns">
          <IssueCard title="Open issues" issues={openIssues} empty="No open tester issues." onAction={(id) => patchIssue.mutate({ id, status: 'RESOLVED' })} actionLabel="Resolve" />
          <IssueCard title="Candidates" issues={candidates} empty="No low-confidence candidates." onAction={(id) => patchIssue.mutate({ id, status: 'OPEN' })} actionLabel="Promote" />
        </div>

        <div className="tops-columns">
          <Card title="Knowledge sources">
            <div className="tops-form">
              <Field label="Title"><Input value={sourceDraft.title} onChange={(e) => setSourceDraft((s) => ({ ...s, title: e.currentTarget.value }))} /></Field>
              <Field label="Doc token"><Input value={sourceDraft.token} onChange={(e) => setSourceDraft((s) => ({ ...s, token: e.currentTarget.value }))} /></Field>
              <Field label="Friendly URL"><Input value={sourceDraft.url} onChange={(e) => setSourceDraft((s) => ({ ...s, url: e.currentTarget.value }))} /></Field>
              <Button size="sm" onClick={() => saveSource.mutate()} disabled={!sourceDraft.title || !sourceDraft.token || saveSource.isPending}>Add source</Button>
            </div>
            <List>
              {(knowledgeQ.data?.sources ?? []).map((source) => (
                <ListRow
                  key={source.id}
                  title={source.title}
                  subtitle={`${source._count.chunks} chunks${source.lastError ? ` · ${source.lastError}` : ''}`}
                  meta={source.lastFetchedAt ? new Date(source.lastFetchedAt).toLocaleString() : 'not fetched'}
                  trailing={<Button size="sm" variant="ghost" onClick={() => refreshSource.mutate(source.id)}>Refresh</Button>}
                />
              ))}
            </List>
          </Card>

          <Card title="AI replay" action={<Bot size={17} strokeWidth={1.8} />}>
            <div className="tops-form">
              <Textarea value={replayText} onChange={(e) => setReplayText(e.currentTarget.value)} />
              <Button size="sm" icon={<PlayCircle size={15} />} onClick={() => replay.mutate()} disabled={!replayText.trim() || replay.isPending}>Replay safely</Button>
            </div>
            <List>
              {(summary?.aiRuns ?? []).map((run) => (
                <ListRow key={run.id} title={`${run.task} · ${run.provider}`} subtitle={run.error ?? run.model} meta={new Date(run.createdAt).toLocaleTimeString()} rail={run.error ? 'danger' : 'accent'} />
              ))}
            </List>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function IssueCard({ title, issues, empty, onAction, actionLabel }: {
  title: string;
  issues: IssueResponse['issues'];
  empty: string;
  actionLabel: string;
  onAction: (id: string) => void;
}) {
  return (
    <Card title={title} action={<Tag status="neutral" mono>{issues.length}</Tag>}>
      {issues.length === 0 ? (
        <EmptyState title={empty} description="Timo will keep this queue quiet unless there is signal." />
      ) : (
        <List>
          {issues.map((issue) => (
            <ListRow
              key={issue.id}
              title={issue.summary}
              subtitle={issue.sourceMessageText ?? 'No source text'}
              meta={`${Math.round(issue.confidence * 100)}%`}
              rail={issue.severity === 'HIGH' || issue.severity === 'CRITICAL' ? 'danger' : 'warn'}
              trailing={<Button size="sm" variant="ghost" onClick={() => onAction(issue.id)}>{actionLabel}</Button>}
            />
          ))}
        </List>
      )}
    </Card>
  );
}

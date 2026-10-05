import { useState, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Check, Clock3, Camera, History, Pencil, Save, X } from 'lucide-react';
import type {
  LeavePolicyDto,
  MonitoringSettingsAuditDto,
  MonitoringSettingsAuditListResponse,
  WorkspacePolicyDto,
} from '@grind/types';
import { IDLE_THRESHOLD_OPTIONS, SCREENSHOT_INTERVAL_OPTIONS } from '@grind/types';
import { api } from '../lib/api';
import {
  Page,
  PageHeader,
  Card,
  List,
  ListRow,
  Input,
  Field,
  Select,
  Textarea,
  Toggle,
  Tag,
  Button,
  IconButton,
  Banner,
  EmptyState,
  Toolbar,
  Skeleton,
  Stat,
  StatRow,
} from '../ui';
import type { Rail } from '../ui';
import './policy.css';

const RETENTION_OPTIONS = [30, 60, 90, 180, 365];
type MonitoringRisk = 'NORMAL' | 'CAUTION' | 'HIGH';
type MonitoringTiming = { screenshotIntervalMin: number; idleThresholdMin: number };
type WorkspacePolicyPatch = Partial<Pick<
  WorkspacePolicyDto,
  | 'captureApps'
  | 'captureTitles'
  | 'captureUrls'
  | 'retentionDaysScreenshots'
  | 'defaultScreenshotIntervalMin'
  | 'defaultIdleThresholdMin'
>> & { auditReason?: string };

export function PolicyScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const timeZone = me.workspaceTimezone;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspace-policy'],
    queryFn: () => api<WorkspacePolicyDto>('/v1/admin/workspace-policy'),
  });
  const auditQ = useQuery({
    queryKey: ['admin', 'monitoring-settings-audits'],
    queryFn: () => api<MonitoringSettingsAuditListResponse>('/v1/admin/monitoring-settings-audits?limit=20'),
  });

  const [draft, setDraft] = useState<WorkspacePolicyDto | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const leaveQ = useQuery({
    queryKey: ['admin', 'leave-policy'],
    queryFn: () => api<LeavePolicyDto>('/v1/admin/leave/policy'),
  });
  const rulesMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<LeavePolicyDto>('/v1/admin/leave/policy', { method: 'PATCH', json: patch }),
    onSuccess: (next) => {
      qc.setQueryData(['admin', 'leave-policy'], next);
      // Codes, balances and the exceptions list all move with the rules.
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      // Attendance views judge days by these rules (no query is keyed
      // 'attendance-exceptions'; the month summary and the attendance grid are).
      qc.invalidateQueries({ queryKey: ['admin', 'month-summary'] });
      qc.invalidateQueries({ queryKey: ['admin', 'attendance'] });
      setRulesOpen(false);
    },
  });
  const [policyRiskPrompt, setPolicyRiskPrompt] = useState<{ patch: WorkspacePolicyPatch; next: MonitoringTiming } | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data);
  }, [q.data, draft]);

  const m = useMutation({
    mutationFn: (patch: WorkspacePolicyPatch) =>
      api<WorkspacePolicyDto>('/v1/admin/workspace-policy', { method: 'PATCH', json: patch }),
    onSuccess: (next) => {
      qc.setQueryData(['workspace-policy'], next);
      // Team settings reads the same policy under its own key.
      qc.invalidateQueries({ queryKey: ['admin', 'workspace-policy'] });
      setDraft(next);
      qc.invalidateQueries({ queryKey: ['admin', 'monitoring-settings-audits'] });
      setPolicyRiskPrompt(null);
    },
  });

  const header = (
    <PageHeader
      eyebrow="Admin · Policy"
      title="Workspace policy"
      subtitle="Admin defaults for capture, screenshots, idle breaks, and attendance rules."
    />
  );

  // Checked before the skeleton: on a failed load `draft` is never set, so the
  // skeleton branch used to win and the page said "Loading policy" forever.
  if (q.isError && !draft) {
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

  if (q.isLoading || !draft) {
    return (
      <Page>
        {header}
        <div className="pol-body">
          <Card title="Loading policy">
            <List>
              {[0, 1, 2, 3].map((i) => (
                <ListRow
                  key={i}
                  title={<Skeleton w={220} h={14} />}
                  subtitle={<Skeleton w={360} h={12} />}
                  trailing={<Skeleton w={80} h={28} radius={999} />}
                />
              ))}
            </List>
          </Card>
        </div>
      </Page>
    );
  }

  const dirty =
    draft.captureApps !== q.data?.captureApps ||
    draft.captureTitles !== q.data?.captureTitles ||
    draft.captureUrls !== q.data?.captureUrls ||
    draft.retentionDaysScreenshots !== q.data?.retentionDaysScreenshots ||
    draft.defaultScreenshotIntervalMin !== q.data?.defaultScreenshotIntervalMin ||
    draft.defaultIdleThresholdMin !== q.data?.defaultIdleThresholdMin;

  async function save() {
    if (!draft) return;
    const patch: WorkspacePolicyPatch = {
      captureApps: draft.captureApps,
      captureTitles: draft.captureTitles,
      captureUrls: draft.captureUrls,
      retentionDaysScreenshots: draft.retentionDaysScreenshots,
      defaultScreenshotIntervalMin: draft.defaultScreenshotIntervalMin,
      defaultIdleThresholdMin: draft.defaultIdleThresholdMin,
    };
    const previousTiming = q.data
      ? {
          screenshotIntervalMin: q.data.defaultScreenshotIntervalMin,
          idleThresholdMin: q.data.defaultIdleThresholdMin,
        }
      : null;
    const nextTiming = {
      screenshotIntervalMin: draft.defaultScreenshotIntervalMin,
      idleThresholdMin: draft.defaultIdleThresholdMin,
    };
    if (
      previousTiming &&
      monitoringTimingChanged(previousTiming, nextTiming) &&
      monitoringRiskLevel(nextTiming) === 'HIGH'
    ) {
      setPolicyRiskPrompt({ patch, next: nextTiming });
      return;
    }
    await m.mutateAsync(patch);
  }

  const saved = m.isSuccess && !dirty;
  const captureCount = [draft.captureApps, draft.captureTitles, draft.captureUrls].filter(Boolean).length;
  const currentRisk = monitoringRiskLevel({
    screenshotIntervalMin: draft.defaultScreenshotIntervalMin,
    idleThresholdMin: draft.defaultIdleThresholdMin,
  });

  return (
    <Page>
      <PageHeader
        eyebrow="Admin · Policy"
        title="Workspace policy"
        subtitle="Admin defaults for capture, screenshots, idle breaks, and attendance rules."
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
        <Card variant="flush" className="pol-summary">
          <StatRow>
            <Stat label="Capture" value={captureCount} unit="/3" hint="apps · titles · URLs" />
            <Stat label="Screenshots" value={formatMinutes(draft.defaultScreenshotIntervalMin)} hint="default" />
            <Stat label="Idle break" value={formatMinutes(draft.defaultIdleThresholdMin)} hint="threshold" />
            <Stat label="Retention" value={draft.retentionDaysScreenshots === 0 ? 'Forever' : `${draft.retentionDaysScreenshots}d`} hint="purge" />
          </StatRow>
        </Card>

        {currentRisk === 'HIGH' ? (
          <Banner status="danger">
            1-minute monitoring is active in this draft. Saving a timing change at this level requires an audit reason.
          </Banner>
        ) : currentRisk === 'CAUTION' ? (
          <Banner status="warn">
            This draft uses a short monitoring cadence. The change will be audit-logged when saved.
          </Banner>
        ) : null}

        {leaveQ.data && (
          <div className="pol-payroll-grid">
            <Card
              title="Attendance rules"
              className="pol-card-compact"
              action={<Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setRulesOpen(true)}>Edit</Button>}
            >
              <div className="pol-payroll-rule-grid">
                <PolicyRule
                  label="Applies from"
                  value={leaveQ.data.attendanceRulesFrom ?? 'Off'}
                  hint={leaveQ.data.attendanceRulesFrom ? 'Every working day since' : 'No day is charged'}
                />
                <PolicyRule label="Full day" value={formatMinutes(leaveQ.data.fullDayMinMinutes)} hint="Less is a half day" />
                <PolicyRule label="Half day" value={formatMinutes(leaveQ.data.halfDayMinMinutes)} hint="Less is a full leave" />
              </div>
            </Card>
            <Card title="Approvals" className="pol-card-compact" action={<Tag mono>Lark</Tag>}>
              <div className="pol-payroll-rule-grid">
                <PolicyRule
                  label="Work from home"
                  value={leaveQ.data.wfhRequiresApproval ? 'Required' : 'Optional'}
                  hint="Tracked time with no punch"
                />
                <PolicyRule
                  label="Late allowed"
                  value={`${leaveQ.data.lateAllowedPerMonth} / month`}
                  hint={`Then ½ day each · ${leaveQ.data.lateGraceMinutes}m grace`}
                />
                <PolicyRule label="Charged to" value="Balance" hint="LWP once it runs out" />
              </div>
            </Card>
          </div>
        )}

        <div className="pol-grid">
          <Card title="Workspace defaults" className="pol-card-compact" action={<Tag mono>New members</Tag>}>
            <List>
              <SelectRow
                icon={<Camera size={16} />}
                title="Default screenshot interval"
                subtitle="New users inherit this; managers may override per member."
                value={draft.defaultScreenshotIntervalMin}
                options={SCREENSHOT_INTERVAL_OPTIONS}
                format={formatMinutes}
                onChange={(value) => setDraft({ ...draft, defaultScreenshotIntervalMin: value })}
              />
              <SelectRow
                icon={<Clock3 size={16} />}
                title="Default idle break threshold"
                subtitle="OS idle time before the agent marks a break candidate."
                value={draft.defaultIdleThresholdMin}
                options={IDLE_THRESHOLD_OPTIONS}
                format={formatMinutes}
                onChange={(value) => setDraft({ ...draft, defaultIdleThresholdMin: value })}
              />
              <ListRow
                leading={<PolicyIcon><Camera size={16} /></PolicyIcon>}
                title="Screenshot retention"
                subtitle="Screenshots older than this are deleted nightly. 1 to 60 days."
                trailing={
                  <div className="pol-field-control">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={draft.retentionDaysScreenshots}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          retentionDaysScreenshots: Math.max(
                            1,
                            Math.min(60, Number(e.target.value) || 1),
                          ),
                        })
                      }
                    />
                    <span className="ui-t-eyebrow">days</span>
                  </div>
                }
              />
              <ListRow
                title="Quick retention"
                subtitle="Preset days."
                trailing={
                  <div className="pol-preset-row">
                    {RETENTION_OPTIONS.map((days) => (
                      <Button
                        key={days}
                        size="sm"
                        variant={draft.retentionDaysScreenshots === days ? 'primary' : 'secondary'}
                        onClick={() => setDraft({ ...draft, retentionDaysScreenshots: days })}
                      >
                        {days}d
                      </Button>
                    ))}
                  </div>
                }
              />
            </List>
          </Card>

          <Card title="Capture & privacy" className="pol-card-compact" action={<Tag mono>{captureCount}/3 enabled</Tag>}>
            <List>
              <PolicyToggleRow
                sensitivity="low"
                title="Capture apps"
                help="App name and bundle ID for usage reports."
                checked={draft.captureApps}
                onChange={(v) => setDraft({ ...draft, captureApps: v })}
              />
              <PolicyToggleRow
                sensitivity="medium"
                title="Capture window titles"
                help="May reveal document or customer names."
                checked={draft.captureTitles}
                onChange={(v) => setDraft({ ...draft, captureTitles: v })}
                disabled={!draft.captureApps}
                disabledHint="Enable app capture first."
              />
              <PolicyToggleRow
                sensitivity="high"
                title="Capture browser URLs"
                help="Current browser URL. Keep off unless documented."
                checked={draft.captureUrls}
                onChange={(v) => setDraft({ ...draft, captureUrls: v })}
                disabled={!draft.captureApps}
                disabledHint="Enable app capture first."
              />
            </List>
          </Card>
        </div>

        {m.isError && (
          <Banner status="danger">Couldn’t save: {(m.error as Error).message}</Banner>
        )}
        <Card title="Monitoring audit" className="pol-card-compact" action={<Tag mono>Recent</Tag>}>
          {auditQ.isLoading ? (
            <List>
              {[0, 1, 2].map((i) => (
                <ListRow
                  key={i}
                  leading={<PolicyIcon><History size={16} /></PolicyIcon>}
                  title={<Skeleton w={180} h={14} />}
                  subtitle={<Skeleton w={360} h={12} />}
                  trailing={<Skeleton w={80} h={24} radius={999} />}
                />
              ))}
            </List>
          ) : auditQ.isError ? (
            <Banner status="danger">Couldn’t load monitoring audit: {(auditQ.error as Error).message}</Banner>
          ) : auditQ.data && auditQ.data.audits.length > 0 ? (
            <List>
              {auditQ.data.audits.map((audit) => (
                <MonitoringAuditRow key={audit.id} audit={audit} timeZone={timeZone} />
              ))}
            </List>
          ) : (
            <EmptyState
              icon={<History size={20} strokeWidth={1.8} />}
              title="No monitoring changes yet"
              description="Screenshot and idle timing edits will appear here."
            />
          )}
        </Card>
        {leaveQ.data && rulesOpen && (
          <AttendanceRulesModal
            policy={leaveQ.data}
            saving={rulesMutation.isPending}
            error={rulesMutation.error instanceof Error ? rulesMutation.error.message : null}
            onClose={() => setRulesOpen(false)}
            onSave={(patch) => rulesMutation.mutate(patch)}
          />
        )}
        {policyRiskPrompt && (
          <MonitoringRiskModal
            title="Confirm 1-minute monitoring"
            description={`This changes workspace defaults to screenshots every ${formatMinutes(policyRiskPrompt.next.screenshotIntervalMin)} and idle break after ${formatMinutes(policyRiskPrompt.next.idleThresholdMin)}.`}
            saving={m.isPending}
            error={m.error instanceof Error ? m.error.message : null}
            onClose={() => setPolicyRiskPrompt(null)}
            onConfirm={(auditReason) => m.mutate({ ...policyRiskPrompt.patch, auditReason })}
          />
        )}
      </div>
    </Page>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}m`;
  }
  return `${minutes}m`;
}

function PolicyRule({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="pol-payroll-rule">
      <span className="ui-t-eyebrow">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="ui-t-small">{hint}</span>}
    </div>
  );
}

function monitoringRiskLevel(timing: MonitoringTiming): MonitoringRisk {
  if (timing.screenshotIntervalMin === 1 || timing.idleThresholdMin === 1) return 'HIGH';
  if (timing.screenshotIntervalMin === 2 || timing.idleThresholdMin <= 3) return 'CAUTION';
  return 'NORMAL';
}

function monitoringTimingChanged(previous: MonitoringTiming, next: MonitoringTiming): boolean {
  return previous.screenshotIntervalMin !== next.screenshotIntervalMin ||
    previous.idleThresholdMin !== next.idleThresholdMin;
}

function MonitoringAuditRow({ audit, timeZone }: { audit: MonitoringSettingsAuditDto; timeZone: string }) {
  const target = audit.scope === 'WORKSPACE_POLICY'
    ? 'Workspace defaults'
    : audit.targetUser?.name ?? 'Deleted member';
  const actor = audit.actor?.name ?? 'System';
  return (
    <ListRow
      leading={<PolicyIcon><History size={16} /></PolicyIcon>}
      title={`${target} · ${formatAuditChange(audit)}`}
      subtitle={
        <span className="pol-audit-sub">
          <span>{actor}</span>
          <span>{formatAuditTime(audit.createdAt, timeZone)}</span>
          {audit.reason && <span>{audit.reason}</span>}
        </span>
      }
      trailing={<RiskTag risk={audit.riskLevel} />}
    />
  );
}

function formatAuditChange(audit: MonitoringSettingsAuditDto): string {
  const changes: string[] = [];
  if (audit.previousScreenshotIntervalMin !== audit.nextScreenshotIntervalMin) {
    changes.push(`shots ${formatNullableMinutes(audit.previousScreenshotIntervalMin)} → ${formatNullableMinutes(audit.nextScreenshotIntervalMin)}`);
  }
  if (audit.previousIdleThresholdMin !== audit.nextIdleThresholdMin) {
    changes.push(`idle ${formatNullableMinutes(audit.previousIdleThresholdMin)} → ${formatNullableMinutes(audit.nextIdleThresholdMin)}`);
  }
  if (audit.previousIdleWarningSeconds !== audit.nextIdleWarningSeconds) {
    changes.push(`idle alert ${formatNullableSeconds(audit.previousIdleWarningSeconds)} → ${formatNullableSeconds(audit.nextIdleWarningSeconds)}`);
  }
  return changes.join(', ') || 'settings unchanged';
}

function formatNullableMinutes(value: number | null): string {
  return value === null ? '-' : formatMinutes(value);
}

function formatNullableSeconds(value: number | null): string {
  return value === null ? 'off' : `${value}s`;
}

function formatAuditTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

function RiskTag({ risk }: { risk: MonitoringRisk }) {
  const status = risk === 'HIGH' ? 'danger' : risk === 'CAUTION' ? 'warn' : 'neutral';
  return <Tag status={status} mono>{risk.toLowerCase()}</Tag>;
}

function MonitoringRiskModal({
  title,
  description,
  saving,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (auditReason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const modal = (
    <div className="ui-overlay pol-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="pol-modal pol-risk-modal" role="dialog" aria-modal="true" aria-labelledby="pol-risk-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pol-modal-head">
          <div className="pol-modal-title">
            <div className="ui-t-eyebrow">Monitoring audit</div>
            <h2 id="pol-risk-title" className="ui-t-title">{title}</h2>
            <p className="ui-t-small">{description}</p>
          </div>
          <IconButton aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="pol-modal-body">
          <Banner status="danger">
            1-minute monitoring is exceptional. Record why this is needed before saving.
          </Banner>
          <Field label="Audit reason" hint="Required. Be specific enough for later review.">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Example: temporary QA window for a customer escalation, approved by Ops."
              autoFocus
            />
          </Field>
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <footer className="pol-modal-foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Save size={15} />}
            onClick={() => onConfirm(trimmed)}
            loading={saving}
            disabled={!trimmed}
          >
            Save with audit
          </Button>
        </footer>
      </section>
    </div>
  );
  return createPortal(modal, document.body);
}

/**
 * The attendance rules: from when, and how many tracked minutes a day needs.
 *
 * Charges are real — a day that falls short draws on the leave balance — so the
 * dialog says so in plain words before anybody saves.
 */
function AttendanceRulesModal({
  policy,
  saving,
  error,
  onClose,
  onSave,
}: {
  policy: LeavePolicyDto;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [from, setFrom] = useState(policy.attendanceRulesFrom ?? '');
  const [fullDay, setFullDay] = useState(String(policy.fullDayMinMinutes));
  const [halfDay, setHalfDay] = useState(String(policy.halfDayMinMinutes));
  const [wfh, setWfh] = useState(policy.wfhRequiresApproval);
  const [lateAllowed, setLateAllowed] = useState(String(policy.lateAllowedPerMonth));
  const late = Number.parseInt(lateAllowed, 10);
  const [graceText, setGraceText] = useState(String(policy.lateGraceMinutes));
  const grace = Number.parseInt(graceText, 10);

  const full = Number.parseInt(fullDay, 10);
  const half = Number.parseInt(halfDay, 10);
  const valid =
    Number.isFinite(full) && Number.isFinite(half) && half >= 0 && full <= 1440 && half <= full &&
    Number.isFinite(late) && late >= 0 && late <= 31 &&
    Number.isFinite(grace) && grace >= 0 && grace <= 240;

  function submit() {
    onSave({
      attendanceRulesFrom: from.trim() === '' ? null : from,
      fullDayMinMinutes: full,
      halfDayMinMinutes: half,
      wfhRequiresApproval: wfh,
      lateAllowedPerMonth: late,
      lateGraceMinutes: grace,
    });
  }

  const modal = (
    <div className="ui-overlay pol-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="pol-modal" role="dialog" aria-modal="true" aria-labelledby="pol-rules-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pol-modal-head">
          <div className="pol-modal-title">
            <div className="ui-t-eyebrow">Attendance rules</div>
            <h2 id="pol-rules-title" className="ui-t-title">Minimum hours and approvals</h2>
            <p className="ui-t-small">Hours are Timo&rsquo;s tracked time — work, meetings and approved manual time.</p>
          </div>
          <IconButton aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="pol-modal-body">
          <section className="pol-form-section" aria-label="Minimum hours">
            <div className="pol-form-section-head">
              <div>
                <h3 className="ui-t-h3">Minimum hours</h3>
                <p className="ui-t-small">In minutes. Working days only.</p>
              </div>
              <Tag mono>Admin</Tag>
            </div>
            <div className="pol-form-grid pol-form-grid--rules">
              <Field label="Applies from" hint="Empty turns the rules off.">
                <Input className="pol-input-mono" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Full day" hint={Number.isFinite(full) ? `${formatMinutes(full)} — less is a half day.` : 'Minutes.'}>
                <Input className="pol-input-mono" value={fullDay} onChange={(e) => setFullDay(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Half day" hint={Number.isFinite(half) ? `${formatMinutes(half)} — less is a full leave.` : 'Minutes.'}>
                <Input className="pol-input-mono" value={halfDay} onChange={(e) => setHalfDay(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Late allowed" hint="A month. Each one after is half a day.">
                <Input className="pol-input-mono" value={lateAllowed} onChange={(e) => setLateAllowed(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Late grace" hint="Minutes after shift start, for everyone.">
                <Input className="pol-input-mono" value={graceText} onChange={(e) => setGraceText(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          </section>

          <section className="pol-form-section" aria-label="Approvals">
            <List>
              <ListRow
                title="Work from home needs an approved Lark request"
                subtitle="A day with tracked time and no punch, without an approved WFH request, counts as leave."
                trailing={<Toggle checked={wfh} onChange={setWfh} />}
              />
            </List>
          </section>

          <Banner status="info" className="pol-modal-note">
            A day that falls short becomes leave: paid from the leave balance while it lasts, unpaid after. Absent
            without approved leave is leave without approval. A manager&rsquo;s correction always wins.
          </Banner>
          {!valid && (
            <Banner status="warn">
              The half-day minimum has to be at most the full-day minimum, late allowed 0–31 and grace 0–240 minutes.
            </Banner>
          )}
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <footer className="pol-modal-foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Save size={15} />} onClick={submit} loading={saving} disabled={!valid}>
            Save attendance rules
          </Button>
        </footer>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}

function SelectRow<T extends number>({
  icon,
  title,
  subtitle,
  value,
  options,
  format,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  value: T;
  options: readonly T[];
  format: (value: number) => string;
  onChange: (value: T) => void;
}) {
  return (
    <ListRow
      leading={<PolicyIcon>{icon}</PolicyIcon>}
      title={title}
      subtitle={subtitle}
      trailing={
        <Select
          className="pol-select"
          value={value}
          onChange={(e) => onChange(Number(e.target.value) as T)}
          aria-label={title}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {format(option)}
            </option>
          ))}
        </Select>
      }
    />
  );
}

const SENSITIVITY_RAIL: Record<'low' | 'medium' | 'high', Rail> = {
  low: 'success',
  medium: 'warn',
  high: 'danger',
};

function PolicyToggleRow({
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
      trailing={<Toggle checked={effective} disabled={disabled} onChange={onChange} />}
    />
  );
}

function PolicyIcon({ children }: { children: ReactNode }) {
  return <span className="pol-icon" aria-hidden>{children}</span>;
}

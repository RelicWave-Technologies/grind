import { useState, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Check, Clock3, Camera, History, Pencil, Save, X } from 'lucide-react';
import type {
  MonitoringSettingsAuditDto,
  MonitoringSettingsAuditListResponse,
  WorkspacePolicyDto,
} from '@grind/types';
import { SCREENSHOT_INTERVAL_OPTIONS } from '@grind/types';
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

interface PayrollPolicyDto {
  halfDayLowerMin: number;
  halfDayUpperMin: number;
  fullDayLowerMin: number;
  fullDayUpperMin: number;
  monthlyLowerMin: number;
  timezone: string;
  approvalReminderDays: number[];
  approvalReminderTime: string;
  payrollSheetSendDay: number;
  payrollSheetSendTime: string;
  sendPayrollSheetTo: 'all_admins';
  updatedAt: string;
}

interface PayrollFormState {
  halfDayLowerMin: string;
  fullDayLowerMin: string;
  fullDayUpperMin: string;
  monthlyLowerMin: string;
  timezone: string;
  approvalReminderDays: string;
  approvalReminderTime: string;
  payrollSheetSendDay: string;
  payrollSheetSendTime: string;
}

const IDLE_THRESHOLD_OPTIONS = [1, 3, 5, 10, 15, 30, 45, 60, 120];
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
  const payrollQ = useQuery({
    queryKey: ['payroll-policy'],
    queryFn: () => api<PayrollPolicyDto>('/v1/admin/payroll/policy'),
  });
  const auditQ = useQuery({
    queryKey: ['admin', 'monitoring-settings-audits'],
    queryFn: () => api<MonitoringSettingsAuditListResponse>('/v1/admin/monitoring-settings-audits?limit=20'),
  });

  const [draft, setDraft] = useState<WorkspacePolicyDto | null>(null);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [policyRiskPrompt, setPolicyRiskPrompt] = useState<{ patch: WorkspacePolicyPatch; next: MonitoringTiming } | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data);
  }, [q.data, draft]);

  const m = useMutation({
    mutationFn: (patch: WorkspacePolicyPatch) =>
      api<WorkspacePolicyDto>('/v1/admin/workspace-policy', { method: 'PATCH', json: patch }),
    onSuccess: (next) => {
      qc.setQueryData(['workspace-policy'], next);
      setDraft(next);
      qc.invalidateQueries({ queryKey: ['admin', 'monitoring-settings-audits'] });
      setPolicyRiskPrompt(null);
    },
  });
  const payrollMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<PayrollPolicyDto>('/v1/admin/payroll/policy', { method: 'PATCH', json: patch }),
    onSuccess: (next) => {
      qc.setQueryData(['payroll-policy'], next);
      qc.invalidateQueries({ queryKey: ['admin', 'payroll'] });
      setPayrollOpen(false);
    },
  });

  const header = (
    <PageHeader
      eyebrow="Admin · Policy"
      title="Workspace policy"
      subtitle="Admin defaults for capture, screenshots, idle breaks, payroll, and Lark close."
    />
  );

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
        subtitle="Admin defaults for capture, screenshots, idle breaks, payroll, and Lark close."
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

        <div className="pol-payroll-grid">
          {payrollQ.isLoading || !payrollQ.data ? (
            <Card title="Payroll policy">
              <List>
                <ListRow title={<Skeleton w={180} h={14} />} subtitle={<Skeleton w={320} h={12} />} />
                <ListRow title={<Skeleton w={180} h={14} />} subtitle={<Skeleton w={320} h={12} />} />
              </List>
            </Card>
          ) : (
            <>
              <Card
                title="Payroll rules"
                className="pol-card-compact"
                action={<Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setPayrollOpen(true)}>Edit</Button>}
              >
                <div className="pol-payroll-rule-grid">
                  <PolicyRule label="Half day" value={`${formatMinutes(payrollQ.data.halfDayLowerMin)} - ${formatMinutes(payrollQ.data.halfDayUpperMin)}`} />
                  <PolicyRule label="Full day" value={`${formatMinutes(payrollQ.data.fullDayLowerMin)} - ${formatMinutes(payrollQ.data.fullDayUpperMin)}`} />
                  <PolicyRule label="Monthly lower" value={formatMinutes(payrollQ.data.monthlyLowerMin)} />
                </div>
              </Card>
              <Card title="Month close" className="pol-card-compact" action={<Tag mono>Lark</Tag>}>
                <div className="pol-payroll-rule-grid pol-payroll-rule-grid--close">
                  <PolicyRule label="Reminders" value={`${payrollQ.data.approvalReminderDays.join(', ')} · ${payrollQ.data.approvalReminderTime}`} hint="Members + managers" />
                  <PolicyRule label="Sheet send" value={`${payrollQ.data.payrollSheetSendDay} · ${payrollQ.data.payrollSheetSendTime}`} hint="Admins" />
                  <PolicyRule label="Timezone" value={payrollQ.data.timezone} hint="Close jobs" />
                </div>
              </Card>
            </>
          )}
        </div>

        {payrollQ.isError && (
          <Banner status="danger">Couldn’t load payroll policy: {(payrollQ.error as Error).message}</Banner>
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
                subtitle="Nightly screenshot purge. Set 0 to keep forever."
                trailing={
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
        {payrollQ.data && payrollOpen && (
          <PayrollPolicyModal
            policy={payrollQ.data}
            saving={payrollMutation.isPending}
            error={payrollMutation.error instanceof Error ? payrollMutation.error.message : null}
            onClose={() => setPayrollOpen(false)}
            onSave={(patch) => payrollMutation.mutate(patch)}
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
  const shot = `${formatNullableMinutes(audit.previousScreenshotIntervalMin)} → ${formatNullableMinutes(audit.nextScreenshotIntervalMin)}`;
  const idle = `${formatNullableMinutes(audit.previousIdleThresholdMin)} → ${formatNullableMinutes(audit.nextIdleThresholdMin)}`;
  return `shots ${shot}, idle ${idle}`;
}

function formatNullableMinutes(value: number | null): string {
  return value === null ? '-' : formatMinutes(value);
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

function payrollPolicyToForm(policy: PayrollPolicyDto): PayrollFormState {
  return {
    halfDayLowerMin: String(policy.halfDayLowerMin),
    fullDayLowerMin: String(policy.fullDayLowerMin),
    fullDayUpperMin: String(policy.fullDayUpperMin),
    monthlyLowerMin: String(policy.monthlyLowerMin),
    timezone: policy.timezone,
    approvalReminderDays: policy.approvalReminderDays.join(', '),
    approvalReminderTime: policy.approvalReminderTime,
    payrollSheetSendDay: String(policy.payrollSheetSendDay),
    payrollSheetSendTime: policy.payrollSheetSendTime,
  };
}

function PayrollPolicyModal({
  policy,
  saving,
  error,
  onClose,
  onSave,
}: {
  policy: PayrollPolicyDto;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState<PayrollFormState>(() => payrollPolicyToForm(policy));
  const set = (key: keyof PayrollFormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function submit() {
    const fullDayLowerMin = Number.parseInt(form.fullDayLowerMin, 10);
    onSave({
      halfDayLowerMin: Number.parseInt(form.halfDayLowerMin, 10),
      halfDayUpperMin: fullDayLowerMin,
      fullDayLowerMin,
      fullDayUpperMin: Number.parseInt(form.fullDayUpperMin, 10),
      monthlyLowerMin: Number.parseInt(form.monthlyLowerMin, 10),
      timezone: form.timezone.trim(),
      approvalReminderDays: form.approvalReminderDays
        .split(',')
        .map((day) => Number.parseInt(day.trim(), 10))
        .filter((day) => Number.isFinite(day)),
      approvalReminderTime: form.approvalReminderTime,
      payrollSheetSendDay: Number.parseInt(form.payrollSheetSendDay, 10),
      payrollSheetSendTime: form.payrollSheetSendTime,
      sendPayrollSheetTo: 'all_admins',
    });
  }

  const modal = (
    <div className="ui-overlay pol-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="pol-modal" role="dialog" aria-modal="true" aria-labelledby="pol-payroll-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pol-modal-head">
          <div className="pol-modal-title">
            <div className="ui-t-eyebrow">Payroll policy</div>
            <h2 id="pol-payroll-title" className="ui-t-title">Rules and Lark month close</h2>
            <p className="ui-t-small">Set thresholds and Lark close timing.</p>
          </div>
          <IconButton aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="pol-modal-body">
          <section className="pol-form-section" aria-label="Payable day rules">
            <div className="pol-form-section-head">
              <div>
                <h3 className="ui-t-h3">Payable day rules</h3>
                <p className="ui-t-small">Shift-working days only.</p>
              </div>
              <Tag mono>Admin</Tag>
            </div>
            <div className="pol-form-grid pol-form-grid--rules">
              <Field label="Half lower" hint="Min for Half.">
                <Input className="pol-input-mono" value={form.halfDayLowerMin} onChange={(e) => set('halfDayLowerMin', e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Full lower" hint="Half upper too.">
                <Input className="pol-input-mono" value={form.fullDayLowerMin} onChange={(e) => set('fullDayLowerMin', e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Full upper" hint="Extra ignored.">
                <Input className="pol-input-mono" value={form.fullDayUpperMin} onChange={(e) => set('fullDayUpperMin', e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Monthly lower" hint="Guarantee line.">
                <Input className="pol-input-mono" value={form.monthlyLowerMin} onChange={(e) => set('monthlyLowerMin', e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          </section>

          <section className="pol-form-section" aria-label="Lark month close">
            <div className="pol-form-section-head">
              <div>
                <h3 className="ui-t-h3">Lark month close</h3>
                <p className="ui-t-small">Reminders notify member + manager. Sheets go to admins.</p>
              </div>
              <Tag mono>Lark</Tag>
            </div>
            <div className="pol-form-grid pol-form-grid--close">
              <Field label="Timezone" hint="IANA zone.">
                <Input className="pol-input-mono" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
              </Field>
              <Field label="Reminder days" hint="Month days.">
                <Input className="pol-input-mono" value={form.approvalReminderDays} onChange={(e) => set('approvalReminderDays', e.target.value)} />
              </Field>
              <Field label="Reminder time" hint="Member + manager.">
                <Input className="pol-input-mono" type="time" value={form.approvalReminderTime} onChange={(e) => set('approvalReminderTime', e.target.value)} />
              </Field>
              <Field label="Sheet day" hint="Month day.">
                <Input className="pol-input-mono" value={form.payrollSheetSendDay} onChange={(e) => set('payrollSheetSendDay', e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Sheet time" hint="Admins.">
                <Input className="pol-input-mono" type="time" value={form.payrollSheetSendTime} onChange={(e) => set('payrollSheetSendTime', e.target.value)} />
              </Field>
            </div>
          </section>

          <Banner status="info" className="pol-modal-note">
            Reminders go to the member/requester and manager/approver. Payroll sheets go to admins.
          </Banner>
          {error && <Banner status="danger">{error}</Banner>}
        </div>
        <footer className="pol-modal-foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Save size={15} />} onClick={submit} loading={saving}>Save payroll policy</Button>
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

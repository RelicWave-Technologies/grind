import './home.css';
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock4,
  Inbox,
  ChevronRight,
  User,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AppUsageEntry, DayInsight, ManualTimeRequest } from '../lib/types';
import { fmtDayLabel, fmtDurationMs, fmtTime, todayKey } from '../lib/format';
import { DayRibbon } from '../components/DayRibbon';
import { AppIcon } from '../components/AppIcon';
import {
  Page,
  PageHeader,
  Card,
  List,
  ListRow,
  Button,
  Toolbar,
  Tag,
  Skeleton,
} from '../ui';

interface ListResponse<T> {
  requests?: T[];
}

/**
 * Home — member landing screen. It answers the first useful question:
 * "what needs attention today?" Managers/admins route to /overview, so this
 * page stays self-scoped and reuses the same data sources as Edit Time and
 * Approvals. Page CSS is layout-only; visual language comes from the shared UI
 * kit and tokens.
 */
export function HomeScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const hour = new Date().getHours();
  const partOfDay = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const today = todayKey();
  const dayQ = useQuery({
    queryKey: ['insights', 'day', today, tz, me.id],
    queryFn: () => api<DayInsight>(`/v1/insights/day?date=${today}&tz=${encodeURIComponent(tz)}`),
  });
  const pendingApprovalsQ = useQuery({
    queryKey: ['time-requests', 'mine', 'PENDING', me.id],
    queryFn: () => api<ListResponse<ManualTimeRequest>>('/v1/time-requests?role=mine&status=PENDING'),
    retry: false,
  });

  const day = dayQ.data;
  const trackedMs = dayQ.data?.totals.workedMs ?? 0;
  const meetingMs = dayQ.data?.totals.meetingMs ?? 0;
  const manualMs = dayQ.data?.totals.manualMs ?? 0;
  const totalMs = trackedMs + meetingMs + manualMs;
  const gapMs = dayQ.data?.totals.gapMs ?? 0;
  const pendingMs = dayQ.data?.totals.pendingMs ?? 0;

  const productivity = dayQ.data?.activity?.buckets
    ? avgNonNull(dayQ.data.activity.buckets)
    : null;
  const blocks = dayQ.data?.blocks ?? [];
  const gapCount = blocks.filter((b) => b.kind === 'GAP' && b.durationMs > 0).length;
  const pendingBlocks = blocks.filter((b) => b.kind === 'PENDING');
  const pendingRequests = pendingApprovalsQ.data?.requests ?? [];
  const approvalPreview = pendingRequests.slice(0, 3);
  const topApps = dayQ.data?.appUsage?.topApps ?? [];
  const topApp = topApps[0] ?? null;

  const firstName = me.name.split(' ')[0] ?? 'there';
  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  })
    .format(new Date())
    .toUpperCase();

  const status = day ? getDayStatus(day, totalMs, gapMs, pendingBlocks.length) : null;
  const firstLast = day ? formatFirstLast(day) : '—';
  const startedLabel = day?.firstActivityAt ? fmtTime(day.firstActivityAt, tz) : '—';
  const pendingApprovalCount = Math.max(pendingBlocks.length, pendingRequests.length);
  const actionRows = useMemo(
    () => buildActionRows({
      gapCount,
      gapMs,
      pendingCount: pendingApprovalCount,
      pendingMs,
      hasWorked: totalMs > 0,
    }),
    [gapCount, gapMs, pendingApprovalCount, pendingMs, totalMs],
  );

  return (
    <Page className="hm-page">
      <PageHeader
        eyebrow={`${partOfDay} · ${dateLine}`}
        title={`${firstName}, here's today`}
        subtitle={
          dayQ.isLoading
            ? 'Loading your current day.'
            : totalMs > 0
            ? `You've tracked ${fmtDurationMs(totalMs)} today — keep the rhythm.`
            : 'No tracked time yet. Start the agent or review missing time.'
        }
        actions={
          <Toolbar>
            <Button
              variant="primary"
              icon={<Clock4 size={15} strokeWidth={2} />}
              onClick={() => navigate({ to: '/edit-time' })}
            >
              Edit Time
            </Button>
            <Button
              variant="secondary"
              icon={<BarChart3 size={15} strokeWidth={2} />}
              onClick={() => navigate({ to: '/reports' })}
            >
              Reports
            </Button>
          </Toolbar>
        }
      />

      <Card
        title="Today"
        className="hm-command-card ui-rise-1"
        action={status ? <Tag status={status.status} mono>{status.label}</Tag> : <Tag mono>Loading</Tag>}
      >
        <div className="hm-command">
          <HomeMetric
            label="Tracked today"
            value={dayQ.isLoading ? '—' : fmtDurationMs(totalMs)}
            sub={firstLast === '—' ? 'No activity window yet' : firstLast}
            tone="lime"
            featured
          />
          <HomeMetric
            label="Started"
            value={startedLabel}
            sub={status?.label ?? 'Loading status'}
            tone="mint"
          />
          <HomeMetric
            label="Pending approval"
            value={pendingApprovalCount}
            sub={pendingApprovalCount > 0 ? `${fmtDurationMs(pendingMs)} waiting` : 'Nothing pending'}
            tone="cream"
          />
          <HomeMetric
            label="Missing time"
            value={gapMs > 0 ? fmtDurationMs(gapMs) : 'None'}
            sub={gapCount > 0 ? `${gapCount} gap${gapCount === 1 ? '' : 's'} to review` : 'Timeline is clean'}
            tone="coral"
          />
        </div>
      </Card>

      <div className="hm-grid">
        <Card
          title="Timeline"
          className="hm-timeline-card hm-grid-card--timeline ui-rise-2"
          action={day?.shift ? <Tag mono>{day.shift.name}</Tag> : <Tag mono>Full day</Tag>}
        >
          <div className="hm-day-brief">
            <InfoPill label="First / last" value={firstLast} />
            <InfoPill label="Meetings" value={fmtDurationMs(meetingMs)} />
            <InfoPill label="Top app" value={topApp ? topApp.app : '—'} />
          </div>

          <div className="hm-ribbon-shell">
            {dayQ.isLoading && <Skeleton h={84} radius="var(--ui-r-sm)" />}
            {day && <DayRibbon day={day} now={Date.now()} editable={false} />}
          </div>

          <div className="hm-timeline-insights">
            <div className="hm-timeline-insight">
              <span className="ui-t-eyebrow">Activity</span>
              <div className="hm-activity-readout">
                <strong className="hm-activity-value ui-t-title">
                  {productivity == null ? '—' : `${productivity}%`}
                </strong>
                <span className="ui-t-small">{activityLabel(productivity)}</span>
              </div>
            </div>

            <div className="hm-timeline-insight hm-timeline-insight--apps">
              <span className="ui-t-eyebrow">Apps</span>
              {topApps.length > 0 ? (
                <div className="hm-app-strip">
                  {topApps.slice(0, 3).map((app) => (
                    <AppUsageChip key={`${app.app}-${app.appBundle ?? ''}`} app={app} />
                  ))}
                </div>
              ) : (
                <span className="hm-app-empty ui-t-small">No app activity yet</span>
              )}
            </div>
          </div>
        </Card>

        <Card title="Next actions" className="hm-actions-card hm-grid-card--actions ui-rise-2">
          <List>
            {actionRows.map((row) => (
              <QuickLink
                key={row.title}
                icon={row.icon}
                title={row.title}
                sub={row.sub}
                tag={row.tag}
                rail={row.rail}
                onClick={() => navigate(row.to)}
              />
            ))}
          </List>
        </Card>

        <Card
          title="Approval status"
          className="hm-approval-card hm-grid-card--approval ui-rise-3"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: '/approvals' })}
            >
              View all
            </Button>
          }
        >
          <div className="hm-approval-summary">
            <span className="ui-t-eyebrow">Waiting now</span>
            <strong className="hm-approval-summary__value ui-t-title">
              {pendingApprovalCount === 0
                ? 'Nothing pending'
                : `${pendingApprovalCount} request${pendingApprovalCount === 1 ? '' : 's'}`}
            </strong>
            <span className="ui-t-small">
              {pendingApprovalCount > 0 ? `${fmtDurationMs(pendingMs)} awaiting review` : 'Sent approvals will appear here'}
            </span>
          </div>

          <List className="hm-approval-list">
            {approvalPreview.length > 0 ? (
              approvalPreview.map((req) => (
                <ApprovalRequestRow
                  key={req.id}
                  req={req}
                  tz={tz}
                  onClick={() => navigate({ to: '/approvals' })}
                />
              ))
            ) : (
              <ListRow
                leading={<span className="hm-link-icon"><CheckCircle2 size={18} strokeWidth={1.9} /></span>}
                title="No pending approvals"
                subtitle="Your sent manual-time requests are clear."
                meta={<Tag status="success" mono>OK</Tag>}
              />
            )}
          </List>
        </Card>

        <Card title="Work context" className="hm-context-card hm-grid-card--context ui-rise-3">
          <List>
            <ContextRow
              icon={<CalendarDays size={17} strokeWidth={1.8} />}
              title={day?.shift ? `${day.shift.start}-${day.shift.end}` : 'No shift'}
              sub={day?.shift?.name ?? 'Full-day timeline'}
            />
            <ContextRow
              icon={<Activity size={17} strokeWidth={1.8} />}
              title={activityLabel(productivity)}
              sub={productivity == null ? 'Waiting for activity samples' : `${productivity}% average today`}
            />
            <ContextRow
              icon={<User size={17} strokeWidth={1.8} />}
              title={me.name}
              sub={me.email}
            />
          </List>
        </Card>
      </div>
    </Page>
  );
}

function HomeMetric({
  label,
  value,
  sub,
  tone,
  featured,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone: 'cream' | 'coral' | 'lime' | 'mint';
  featured?: boolean;
}) {
  return (
    <div className={`hm-home-metric hm-home-metric--${tone}${featured ? ' is-featured' : ''}`}>
      <span className="ui-t-eyebrow">{label}</span>
      <span className="hm-home-metric__value ui-t-display">{value}</span>
      {sub != null && <span className="hm-home-metric__sub ui-t-small">{sub}</span>}
    </div>
  );
}

function QuickLink({
  icon,
  title,
  sub,
  tag,
  rail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  tag?: ReactNode;
  rail?: 'success' | 'warn' | 'danger' | 'info' | 'accent';
  onClick: () => void;
}) {
  return (
    <ListRow
      leading={<span className="hm-link-icon">{icon}</span>}
      title={title}
      subtitle={sub}
      rail={rail}
      meta={tag}
      trailing={<ChevronRight size={16} strokeWidth={2} className="hm-link-chevron" />}
      onClick={onClick}
    />
  );
}

function ContextRow({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <ListRow
      leading={<span className="hm-link-icon">{icon}</span>}
      title={title}
      subtitle={sub}
    />
  );
}

function ApprovalRequestRow({
  req,
  tz,
  onClick,
}: {
  req: ManualTimeRequest;
  tz: string;
  onClick: () => void;
}) {
  const startMs = new Date(req.requestedStart).getTime();
  const endMs = new Date(req.requestedEnd).getTime();
  const durationMs = Math.max(0, endMs - startMs);
  return (
    <ListRow
      leading={<span className="hm-link-icon"><Inbox size={18} strokeWidth={1.9} /></span>}
      title={approvalTaskLabel(req)}
      subtitle={`${fmtDayLabel(req.requestedStart.slice(0, 10))} · ${fmtTime(startMs, tz)} – ${fmtTime(endMs, tz)}`}
      meta={<Tag status="warn" mono>{fmtDurationMs(durationMs)}</Tag>}
      trailing={<ChevronRight size={16} strokeWidth={2} className="hm-link-chevron" />}
      onClick={onClick}
    />
  );
}

function approvalTaskLabel(req: ManualTimeRequest): string {
  const task = req.taskSummary?.trim();
  if (task) return task;
  return 'Manual time request';
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="hm-info-pill">
      <span className="ui-t-eyebrow">{label}</span>
      <span className="hm-info-value ui-mono">{value}</span>
    </div>
  );
}

function AppUsageChip({ app }: { app: AppUsageEntry }) {
  return (
    <span
      className="hm-app-chip"
      title={`${app.app}${app.appBundle ? ` · ${app.appBundle}` : ''}`}
    >
      <AppIcon name={app.app} iconUrl={app.iconUrl} />
      <span className="hm-app-chip__name ui-t-small">{app.app}</span>
      <span className="hm-app-chip__time ui-mono">{fmtDurationMs(app.minutes * 60_000)}</span>
    </span>
  );
}

function avgNonNull(arr: Array<number | null>): number | null {
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (v !== null) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? null : Math.round(s / n);
}

function activityLabel(value: number | null): string {
  if (value == null) return 'No samples';
  if (value >= 70) return 'Strong focus';
  if (value >= 40) return 'Steady';
  if (value > 0) return 'Quiet';
  return 'Idle samples';
}

function formatFirstLast(day: DayInsight): string {
  if (day.firstActivityAt == null || day.lastActivityAt == null) return '—';
  return `${fmtTime(day.firstActivityAt, day.timezone)} / ${fmtTime(day.lastActivityAt, day.timezone)}`;
}

function getDayStatus(
  day: DayInsight,
  totalMs: number,
  gapMs: number,
  pendingCount: number,
): { label: string; status: 'success' | 'warn' | 'neutral' | 'info' } {
  if (pendingCount > 0) return { label: 'Pending', status: 'warn' };
  if (totalMs > 0 && gapMs === 0) return { label: 'Clean', status: 'success' };
  if (totalMs > 0) return { label: 'Review', status: 'info' };
  if (!day.shift) return { label: 'No shift', status: 'neutral' };
  return { label: 'Not started', status: 'neutral' };
}

function buildActionRows({
  gapCount,
  gapMs,
  pendingCount,
  pendingMs,
  hasWorked,
}: {
  gapCount: number;
  gapMs: number;
  pendingCount: number;
  pendingMs: number;
  hasWorked: boolean;
}): Array<{
  icon: ReactNode;
  title: string;
  sub: string;
  tag?: ReactNode;
  rail?: 'success' | 'warn' | 'danger' | 'info' | 'accent';
  to: { to: string; search?: Record<string, string> };
}> {
  const rows: Array<{
    icon: ReactNode;
    title: string;
    sub: string;
    tag?: ReactNode;
    rail?: 'success' | 'warn' | 'danger' | 'info' | 'accent';
    to: { to: string; search?: Record<string, string> };
  }> = [];

  if (gapCount > 0) {
    rows.push({
      icon: <Clock4 size={18} strokeWidth={1.9} />,
      title: 'Review missing time',
      sub: `${gapCount} gap${gapCount === 1 ? '' : 's'} · ${fmtDurationMs(gapMs)}`,
      tag: <Tag status="warn" mono>Gap</Tag>,
      rail: 'warn',
      to: { to: '/edit-time', search: { date: todayKey() } },
    });
  } else {
    rows.push({
      icon: <CheckCircle2 size={18} strokeWidth={1.9} />,
      title: hasWorked ? 'Timesheet looks clean' : 'Start tracking',
      sub: hasWorked ? 'Open Edit Time for details' : 'Open Edit Time when you need to fill a day',
      tag: <Tag status={hasWorked ? 'success' : 'neutral'} mono>{hasWorked ? 'OK' : 'Start'}</Tag>,
      rail: hasWorked ? 'success' : undefined,
      to: { to: '/edit-time', search: { date: todayKey() } },
    });
  }

  rows.push({
    icon: <Inbox size={18} strokeWidth={1.9} />,
    title: 'Approvals',
    sub: pendingCount > 0 ? `${pendingCount} waiting · ${fmtDurationMs(pendingMs)}` : 'Sent manual-time history',
    tag: pendingCount > 0 ? <Tag status="warn" mono>{pendingCount}</Tag> : undefined,
    rail: pendingCount > 0 ? 'warn' : undefined,
    to: { to: '/approvals' },
  });

  rows.push({
    icon: <BarChart3 size={18} strokeWidth={1.9} />,
    title: 'Reports',
    sub: 'Apps, screenshots, activity, and timeline',
    to: { to: '/reports' },
  });

  rows.push({
    icon: <ArrowUpRight size={18} strokeWidth={1.9} />,
    title: 'Profile',
    sub: 'Team, manager, shift, and capture policy',
    to: { to: '/profile' },
  });

  return rows;
}

import './reports.css';
import { useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import {
  Building2,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock4,
  ExternalLink,
  Images,
  ListTree,
  Mail,
  Rows3,
  Shield,
  SunMedium,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { fmtAgeShort, fmtDayLabel, fmtDurationMs, fmtTime } from '../lib/format';
import { hasCapability } from '../lib/auth';
import type { ManualTimeRequestDto } from '@grind/types';
import type { SelfProfileResponse } from '@grind/types/profile';
import type { ShiftSchedule, Weekday } from '@grind/types/shifts';
import type {
  MemberReportDay,
  MemberReportDayAppsResponse,
  MemberReportDayScreenshotsResponse,
  MemberReportsMeResponse,
  ShiftStatus,
  TeamReportMember,
  TeamMemberReportsResponse,
  TeamReportsResponse,
} from '@grind/types/reports';
import type { Rail, Status } from '../ui';
import type {
  DayInsight,
} from '../lib/types';
import { DayRibbon } from '../components/DayRibbon';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { AppIcon } from '../components/AppIcon';
import {
  Page,
  PageHeader,
  Toolbar,
  Button,
  IconButton,
  Card,
  Stat,
  StatRow,
  Table,
  THead,
  Tbody,
  Th,
  Tr,
  Td,
  Tag,
  Tabs,
  Segmented,
  Avatar,
  Identity,
  Banner,
  EmptyState,
  SkeletonTable,
} from '../ui';

type ModalKind = 'apps' | 'activity' | 'timeline';
type ReportsMode = 'you' | 'team';
type ReportModalState = { kind: ModalKind; date: string; userId?: string };
type DrawerTab = 'reports' | 'approvals' | 'profile';
type ApprovalDecisionAction = 'approve' | 'reject';

const MEMBER_DRAWER_TABS: ReadonlyArray<{ value: DrawerTab; label: string }> = [
  { value: 'reports', label: 'Reports' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'profile', label: 'Profile' },
];

const WEEKDAY_LABELS: ReadonlyArray<{ key: Weekday; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

export function ReportsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = localDateKey();
  const [from, setFrom] = useState(() => addLocalDays(today, -6));
  const [to, setTo] = useState(today);
  const [modal, setModal] = useState<ReportModalState | null>(null);
  const canReadTeam = hasCapability(me, 'reports.team.read');
  const [mode, setMode] = useState<ReportsMode>(() => (canReadTeam ? 'team' : 'you'));
  const [memberDrawer, setMemberDrawer] = useState<{ userId: string; from: string; to: string } | null>(null);
  const activeMode: ReportsMode = canReadTeam ? mode : 'you';

  const reportQ = useQuery({
    queryKey: ['reports', 'me', from, to, tz],
    enabled: activeMode === 'you',
    queryFn: () => {
      const params = new URLSearchParams({ from, to, tz });
      return api<MemberReportsMeResponse>(`/v1/reports/me?${params.toString()}`);
    },
  });

  const teamQ = useQuery({
    queryKey: ['reports', 'team', from, to, tz],
    enabled: activeMode === 'team' && canReadTeam,
    queryFn: () => {
      const params = new URLSearchParams({ from, to, tz });
      return api<TeamReportsResponse>(`/v1/reports/team?${params.toString()}`);
    },
  });

  const days = reportQ.data?.days ?? [];
  const summary = useMemo(() => summarize(days), [days]);
  const selectedDate = modal?.date ?? null;
  const selectedModalUserId = modal?.userId ?? null;

  const appsQ = useQuery({
    queryKey: ['reports', selectedModalUserId ? 'team-member' : 'me', 'day-apps', selectedModalUserId, selectedDate, tz],
    enabled: modal?.kind === 'apps' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz });
      if (selectedModalUserId) {
        params.set('userId', selectedModalUserId);
        return api<MemberReportDayAppsResponse>(`/v1/reports/team/member/day-apps?${params.toString()}`);
      }
      return api<MemberReportDayAppsResponse>(`/v1/reports/me/day-apps?${params.toString()}`);
    },
  });

  const activityQ = useQuery({
    queryKey: ['reports', selectedModalUserId ? 'team-member' : 'me', 'day-screenshots', selectedModalUserId, selectedDate, tz],
    enabled: modal?.kind === 'activity' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz });
      if (selectedModalUserId) {
        params.set('userId', selectedModalUserId);
        return api<MemberReportDayScreenshotsResponse>(`/v1/reports/team/member/day-screenshots?${params.toString()}`);
      }
      return api<MemberReportDayScreenshotsResponse>(`/v1/reports/me/day-screenshots?${params.toString()}`);
    },
  });

  const timelineQ = useQuery({
    queryKey: ['insights', 'day', selectedModalUserId, selectedDate, tz, 'reports-readonly'],
    enabled: modal?.kind === 'timeline' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz });
      if (selectedModalUserId) params.set('userId', selectedModalUserId);
      return api<DayInsight>(`/v1/insights/day?${params.toString()}`);
    },
  });

  function applyCalendarRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
  }

  function switchMode(nextMode: ReportsMode) {
    setModal(null);
    setMemberDrawer(null);
    if (nextMode === 'team' && daysBetween(from, to) > 30) {
      setFrom(addLocalDays(to, -30));
    }
    setMode(nextMode);
  }

  function openTeamMember(userId: string) {
    setModal(null);
    setMemberDrawer({ userId, from, to });
  }

  return (
    <Page className="rep-page">
      <PageHeader
        eyebrow={`${tz.replace(/_/g, ' ')} · ${from} to ${to}`}
        title="Reports"
        subtitle={activeMode === 'team' ? 'Team activity, approvals, apps, and exceptions in one scoped view.' : 'Daily activity, approvals, apps, screenshots, and read-only timelines.'}
        actions={
          <Toolbar>
            {canReadTeam && (
              <Segmented
                items={[
                  { value: 'you', label: 'You' },
                  { value: 'team', label: 'Team' },
                ]}
                value={activeMode}
                onChange={switchMode}
                aria-label="Report mode"
              />
            )}
            <DateRangePicker
              from={from}
              to={to}
              today={today}
              maxDays={activeMode === 'team' ? 31 : 60}
              onChange={applyCalendarRange}
            />
          </Toolbar>
        }
      />

      {activeMode === 'you' && reportQ.isError && (
        <Banner status="danger">Couldn’t load reports: {(reportQ.error as Error).message}</Banner>
      )}
      {activeMode === 'team' && teamQ.isError && (
        <Banner status="danger">Couldn’t load team reports: {(teamQ.error as Error).message}</Banner>
      )}

      {activeMode === 'team' ? (
        <TeamReportsView
          data={teamQ.data}
          loading={teamQ.isLoading}
          onOpenMember={openTeamMember}
        />
      ) : (
        <>
          <Card variant="flush">
            <StatRow>
              <Stat label="Worked" value={fmtDurationMs(summary.workedMs)} />
              <Stat label="Manual" value={fmtDurationMs(summary.manualMs)} />
              <Stat label="Gaps" value={fmtDurationMs(summary.gapMs)} unit={`${summary.gapCount}`} />
              <Stat label="Approvals" value={summary.approvalsTotal} hint={`${summary.approved} accepted · ${summary.pending} pending · ${summary.rejected} rejected`} />
              <Stat label="Activity" value={summary.activityPercent === null ? '—' : `${summary.activityPercent}%`} />
            </StatRow>
          </Card>

          <SelfReportTable days={days} loading={reportQ.isLoading} tz={tz} onOpenModal={setModal} />
        </>
      )}

      {memberDrawer && (
        <TeamMemberDrawer
          userId={memberDrawer.userId}
          initialFrom={memberDrawer.from}
          initialTo={memberDrawer.to}
          today={today}
          tz={tz}
          onClose={() => {
            setMemberDrawer(null);
            setModal(null);
          }}
          onOpenModal={setModal}
        />
      )}

      {modal?.kind === 'apps' && (
        <ReportModal
          title={`Apps · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="sm"
          onClose={() => setModal(null)}
        >
          {appsQ.isLoading && <SkeletonTable rows={5} />}
          {appsQ.isError && <Banner status="danger">{(appsQ.error as Error).message}</Banner>}
          {appsQ.data && <AppsPanel data={appsQ.data} />}
        </ReportModal>
      )}

      {modal?.kind === 'activity' && (
        <ReportModal
          title={`Activity · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="md"
          onClose={() => setModal(null)}
        >
          {activityQ.isLoading && <SkeletonTable rows={4} />}
          {activityQ.isError && <Banner status="danger">{(activityQ.error as Error).message}</Banner>}
          {activityQ.data && <ActivityPanel data={activityQ.data} tz={tz} />}
        </ReportModal>
      )}

      {modal?.kind === 'timeline' && (
        <ReportModal
          title={`Timeline · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="lg"
          onClose={() => setModal(null)}
        >
          {timelineQ.isLoading && <SkeletonTable rows={4} />}
          {timelineQ.isError && <Banner status="danger">{(timelineQ.error as Error).message}</Banner>}
          {timelineQ.data && (
            <div className="rep-timeline-modal">
              <DayRibbon day={timelineQ.data} now={Date.now()} editable={false} />
              {timelineQ.data.activity && timelineQ.data.activity.buckets.length > 0 && (
                <ActivityHeatmap day={timelineQ.data} heatmap={timelineQ.data.activity} />
              )}
            </div>
          )}
        </ReportModal>
      )}
    </Page>
  );
}

function SelfReportTable({
  days,
  loading,
  tz,
  onOpenModal,
}: {
  days: MemberReportDay[];
  loading: boolean;
  tz: string;
  onOpenModal: (modal: ReportModalState) => void;
}) {
  return (
    <Card variant="flush" className="rep-table-card">
      {loading ? (
        <SkeletonTable rows={8} />
      ) : days.length === 0 ? (
        <EmptyState
          icon={<CalendarDays size={22} strokeWidth={1.8} />}
          title="No report rows"
          description="Try a different date range."
        />
      ) : (
        <div className="rep-table-wrap">
          <Table density="compact" stickyHead className="rep-table">
            <THead>
              <Tr>
                <Th className="rep-col-date">Date</Th>
                <Th className="rep-col-worked" align="center">Worked</Th>
                <Th className="rep-col-start" align="center">Start</Th>
                <Th className="rep-col-time" align="center">First / last</Th>
                <Th className="rep-col-approvals" align="center">Approvals</Th>
                <Th className="rep-col-apps" align="center">Apps</Th>
                <Th className="rep-col-activity" align="center">Activity</Th>
                <Th className="rep-col-actions" align="center">Actions</Th>
              </Tr>
            </THead>
            <Tbody>
              {days.map((day) => (
                <Tr key={day.date} rail={railForStatus(day.shiftStatus)}>
                  <Td className="rep-col-date">
                    <div className="rep-date-cell">
                      <span className="ui-t-strong">{fmtDayLabel(day.date)}</span>
                      <span className="ui-t-small ui-ink-3">{day.date}</span>
                    </div>
                  </Td>
                  <Td className="rep-col-worked" mono>{fmtDurationMs(totalDayWorkedMs(day))}</Td>
                  <Td className="rep-col-start" align="center">
                    <Tag status={statusTag(day.shiftStatus)}>{shiftLabel(day.shiftStatus)}</Tag>
                  </Td>
                  <Td className="rep-col-time" align="center">
                    <span className="rep-time-range">
                      {day.firstActivityMs ? fmtTime(day.firstActivityMs, tz) : '—'}
                      <span aria-hidden> / </span>
                      {day.lastActivityMs ? fmtTime(day.lastActivityMs, tz) : '—'}
                    </span>
                  </Td>
                  <Td className="rep-col-approvals" align="center">
                    <ReportApprovalCounts approvals={day.approvals} />
                  </Td>
                  <Td className="rep-col-apps" align="center">
                    <div className="rep-app-cell">
                      <div className="rep-cell-main">
                        {day.topApps[0] ? <AppBadge app={day.topApps[0]} /> : <span className="ui-t-small ui-ink-3">—</span>}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Rows3 size={13} strokeWidth={1.8} />}
                        onClick={() => onOpenModal({ kind: 'apps', date: day.date })}
                        aria-label={`View apps for ${day.date}`}
                        className="rep-cell-view"
                      >
                        View
                      </Button>
                    </div>
                  </Td>
                  <Td className="rep-col-activity" align="center">
                    <div className="rep-activity-cell">
                      <div className="rep-cell-main">
                        <span className="rep-activity-value">{day.activityPercent === null ? '—' : `${day.activityPercent}%`}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Images size={13} strokeWidth={1.8} />}
                        onClick={() => onOpenModal({ kind: 'activity', date: day.date })}
                        aria-label={`View activity for ${day.date}`}
                        className="rep-cell-view"
                      >
                        View
                      </Button>
                    </div>
                  </Td>
                  <Td className="rep-col-actions" align="center">
                    <div className="rep-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<ListTree size={14} strokeWidth={1.8} />}
                        onClick={() => onOpenModal({ kind: 'timeline', date: day.date })}
                      >
                        Timeline
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function TeamReportsView({
  data,
  loading,
  onOpenMember,
}: {
  data?: TeamReportsResponse;
  loading: boolean;
  onOpenMember: (userId: string) => void;
}) {
  if (loading) {
    return <Card variant="flush"><SkeletonTable rows={5} /></Card>;
  }
  if (!data || data.members.length === 0) {
    return (
      <Card variant="flush">
        <EmptyState
          icon={<Users size={22} strokeWidth={1.8} />}
          title="No team members in scope"
          description="Team reports appear after members are assigned to your managed team."
        />
      </Card>
    );
  }

  return (
    <div className="rep-team">
      <section className="rep-team-summary" aria-label="Team report summary">
        <TeamKpi label="Members" value={data.summary.memberCount} sub={`${data.summary.activeDays}/${data.summary.memberDays} active days`} tone="lime" />
        <TeamKpi label="Worked" value={fmtDurationMs(data.summary.workedMs)} sub={`${fmtDurationMs(data.summary.manualMs)} manual`} tone="mint" />
        <TeamKpi label="Late days" value={data.summary.lateDays} sub={`${data.summary.noActivityDays} no-activity days`} tone="cream" />
        <TeamKpi label="Pending" value={data.summary.pendingApprovals} sub={`${data.summary.gapCount} gaps · ${fmtDurationMs(data.summary.gapMs)}`} tone="coral" />
        <TeamKpi label="Activity" value={percentLabel(data.summary.activityPercent)} sub={`${data.summary.screenshots} screenshots`} tone="pink" />
      </section>

      <Card variant="flush" className="rep-team-members-card">
        <div className="rep-team-card-head">
          <div>
            <h2 className="ui-t-title">Members</h2>
            <p className="ui-t-small">Range totals, punctuality, approvals, top app, and member drill-in.</p>
          </div>
          <Tag mono>{data.members.length}</Tag>
        </div>
        <TeamMembersTable members={data.members} onOpenMember={onOpenMember} />
      </Card>
    </div>
  );
}

function TeamKpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  tone: 'lime' | 'mint' | 'cream' | 'coral' | 'pink';
}) {
  return (
    <div className={`rep-team-kpi rep-team-kpi--${tone}`}>
      <span className="ui-t-eyebrow">{label}</span>
      <strong className="ui-t-num">{value}</strong>
      <span className="ui-t-small">{sub}</span>
    </div>
  );
}

function TeamMembersTable({ members, onOpenMember }: { members: TeamReportMember[]; onOpenMember: (userId: string) => void }) {
  return (
    <div className="rep-table-wrap">
      <Table density="compact" className="rep-team-members-table">
        <THead>
          <Tr>
            <Th>Member</Th>
            <Th align="center">Worked</Th>
            <Th align="center">Approved hours</Th>
            <Th align="center">Starts</Th>
            <Th align="center">Approvals</Th>
            <Th align="center">Top app</Th>
            <Th align="center">Avg activity</Th>
            <Th align="center">Open</Th>
          </Tr>
        </THead>
        <Tbody>
          {members.map((member) => (
            <Tr key={member.user.id} rail={member.lateDays > 0 || member.noActivityDays > 0 ? 'warn' : undefined}>
              <Td>
                <Identity
                  avatar={<Avatar name={member.user.name} size={32} />}
                  name={member.user.name}
                  subtitle={member.user.teamName ?? member.user.email}
                />
              </Td>
              <Td align="center">
                <span className="ui-mono">{fmtDurationMs(member.workedMs)}</span>
              </Td>
              <Td align="center">
                <span className="ui-mono">{fmtDurationMs(member.manualMs)}</span>
              </Td>
              <Td align="center"><StartCounts member={member} /></Td>
              <Td align="center">
                <ApprovalCounts member={member} />
              </Td>
              <Td align="center">
                {member.topApps[0] ? <AppBadge app={member.topApps[0]} /> : <span className="ui-t-small ui-ink-3">—</span>}
              </Td>
              <Td align="center">
                <span className="rep-activity-value">{percentLabel(member.activityPercent)}</span>
              </Td>
              <Td align="center">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Clock4 size={14} strokeWidth={1.8} />}
                  onClick={() => onOpenMember(member.user.id)}
                >
                  Open
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  );
}

function StartCounts({ member }: { member: TeamReportMember }) {
  return (
    <CountTagGroup
      ariaLabel={`${member.lateDays} late, ${member.onTimeDays} on time, ${member.offDays} off`}
      items={[
        { value: member.lateDays, code: 'L', label: 'late', status: member.lateDays > 0 ? 'danger' : 'neutral' },
        { value: member.onTimeDays, code: 'O', label: 'on time', status: member.onTimeDays > 0 ? 'success' : 'neutral' },
        { value: member.offDays, code: 'F', label: 'off', status: 'neutral' },
      ]}
    />
  );
}

function ApprovalCounts({ member }: { member: TeamReportMember }) {
  return (
    <CountTagGroup
      ariaLabel={`${member.approvals.pending} pending, ${member.approvals.approved} accepted, ${member.approvals.rejected} rejected`}
      items={[
        { value: member.approvals.pending, code: 'P', label: 'pending', status: 'warn' },
        { value: member.approvals.approved, code: 'A', label: 'accepted', status: 'success' },
        { value: member.approvals.rejected, code: 'R', label: 'rejected', status: 'danger' },
      ]}
    />
  );
}

function ReportApprovalCounts({ approvals }: { approvals: MemberReportDay['approvals'] }) {
  return (
    <CountTagGroup
      ariaLabel={`${approvals.approved} accepted, ${approvals.rejected} rejected, ${approvals.pending} pending`}
      items={[
        { value: approvals.approved, code: 'A', label: 'accepted', status: 'success' },
        { value: approvals.rejected, code: 'R', label: 'rejected', status: 'danger' },
        { value: approvals.pending, code: 'P', label: 'pending', status: 'warn' },
      ]}
    />
  );
}

function CountTagGroup({
  ariaLabel,
  items,
}: {
  ariaLabel: string;
  items: Array<{ value: number; code: string; label: string; status: Status }>;
}) {
  return (
    <span className="rep-count-tags" aria-label={ariaLabel}>
      {items.map((item) => (
        <Tag
          key={item.code}
          status={item.status}
          mono
          className="rep-count-tag"
          tabIndex={0}
          aria-label={`${item.value} ${item.label}`}
        >
          <span className="rep-count-content">
            <span className="rep-count-value">{item.value}</span>
            <span className="rep-count-code">{item.code}</span>
            <span className="rep-count-label">{item.label}</span>
          </span>
        </Tag>
      ))}
    </span>
  );
}

export function TeamMemberDetailDrawer({
  userId,
  initialFrom,
  initialTo,
  today,
  tz,
  onClose,
}: {
  userId: string;
  initialFrom: string;
  initialTo: string;
  today: string;
  tz: string;
  onClose: () => void;
}) {
  const [modal, setModal] = useState<ReportModalState | null>(null);
  const selectedDate = modal?.date ?? null;
  const selectedModalUserId = modal?.userId ?? userId;

  const appsQ = useQuery({
    queryKey: ['reports', 'team-member', 'day-apps', selectedModalUserId, selectedDate, tz],
    enabled: modal?.kind === 'apps' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz, userId: selectedModalUserId });
      return api<MemberReportDayAppsResponse>(`/v1/reports/team/member/day-apps?${params.toString()}`);
    },
  });

  const activityQ = useQuery({
    queryKey: ['reports', 'team-member', 'day-screenshots', selectedModalUserId, selectedDate, tz],
    enabled: modal?.kind === 'activity' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz, userId: selectedModalUserId });
      return api<MemberReportDayScreenshotsResponse>(`/v1/reports/team/member/day-screenshots?${params.toString()}`);
    },
  });

  const timelineQ = useQuery({
    queryKey: ['insights', 'day', selectedModalUserId, selectedDate, tz, 'reports-readonly'],
    enabled: modal?.kind === 'timeline' && !!selectedDate,
    queryFn: () => {
      const params = new URLSearchParams({ date: selectedDate!, tz, userId: selectedModalUserId });
      return api<DayInsight>(`/v1/insights/day?${params.toString()}`);
    },
  });

  function closeDrawer() {
    setModal(null);
    onClose();
  }

  return (
    <>
      <TeamMemberDrawer
        userId={userId}
        initialFrom={initialFrom}
        initialTo={initialTo}
        today={today}
        tz={tz}
        onClose={closeDrawer}
        onOpenModal={(nextModal) => setModal({ ...nextModal, userId: nextModal.userId ?? userId })}
      />

      {modal?.kind === 'apps' && (
        <ReportModal
          title={`Apps · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="sm"
          onClose={() => setModal(null)}
        >
          {appsQ.isLoading && <SkeletonTable rows={5} />}
          {appsQ.isError && <Banner status="danger">{(appsQ.error as Error).message}</Banner>}
          {appsQ.data && <AppsPanel data={appsQ.data} />}
        </ReportModal>
      )}

      {modal?.kind === 'activity' && (
        <ReportModal
          title={`Activity · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="md"
          onClose={() => setModal(null)}
        >
          {activityQ.isLoading && <SkeletonTable rows={4} />}
          {activityQ.isError && <Banner status="danger">{(activityQ.error as Error).message}</Banner>}
          {activityQ.data && <ActivityPanel data={activityQ.data} tz={tz} />}
        </ReportModal>
      )}

      {modal?.kind === 'timeline' && (
        <ReportModal
          title={`Timeline · ${fmtDayLabel(modal.date)}`}
          subtitle={modal.date}
          size="lg"
          onClose={() => setModal(null)}
        >
          {timelineQ.isLoading && <SkeletonTable rows={4} />}
          {timelineQ.isError && <Banner status="danger">{(timelineQ.error as Error).message}</Banner>}
          {timelineQ.data && (
            <div className="rep-timeline-modal">
              <DayRibbon day={timelineQ.data} now={Date.now()} editable={false} />
              {timelineQ.data.activity && timelineQ.data.activity.buckets.length > 0 && (
                <ActivityHeatmap day={timelineQ.data} heatmap={timelineQ.data.activity} />
              )}
            </div>
          )}
        </ReportModal>
      )}
    </>
  );
}

function TeamMemberDrawer({
  userId,
  initialFrom,
  initialTo,
  today,
  tz,
  onClose,
  onOpenModal,
}: {
  userId: string;
  initialFrom: string;
  initialTo: string;
  today: string;
  tz: string;
  onClose: () => void;
  onOpenModal: (modal: ReportModalState) => void;
}) {
  const navigate = useNavigate();
  const { me } = useRouteContext({ from: '/authed' });
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [tab, setTab] = useState<DrawerTab>('reports');
  const canDecideApprovals =
    hasCapability(me, 'approvals.team.decide') ||
    hasCapability(me, 'approvals.workspace.decide');

  const q = useQuery({
    queryKey: ['reports', 'team', 'member', userId, from, to, tz],
    queryFn: () => {
      const params = new URLSearchParams({ userId, from, to, tz });
      return api<TeamMemberReportsResponse>(`/v1/reports/team/member?${params.toString()}`);
    },
  });

  const decide = useMutation({
    mutationFn: async (vars: { id: string; action: ApprovalDecisionAction }) =>
      api(`/v1/admin/manual-time-requests/${vars.id}/decide`, {
        method: 'POST',
        json: { action: vars.action },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports', 'team', 'member', userId] });
      queryClient.invalidateQueries({ queryKey: ['reports', 'team'] });
      queryClient.invalidateQueries({ queryKey: ['approvals', 'team'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  if (typeof document === 'undefined') return null;

  const member = q.data?.member;
  const decisionError = decide.isError ? (decide.error as Error).message : null;
  const identity = member ? (
    <Identity
      avatar={<Avatar name={member.user.name} size={40} />}
      name={member.user.name}
      subtitle={member.user.teamName ?? member.user.email}
    />
  ) : (
    <Identity avatar={<Avatar name="Member" size={40} />} name="Member" subtitle="Loading" />
  );

  return createPortal(
    <div className="rep-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="rep-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={member ? `${member.user.name} reports` : 'Member reports'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rep-drawer-head">
          <div className="rep-drawer-title">
            {identity}
            <div className="rep-drawer-meta">
              <Tag mono>{formatRangeLabel(from, to)}</Tag>
              {member?.user.teamName && <Tag>{member.user.teamName}</Tag>}
            </div>
          </div>
          <Toolbar>
            <DateRangePicker
              from={from}
              to={to}
              today={today}
              maxDays={60}
              onChange={(nextFrom, nextTo) => {
                setFrom(nextFrom);
                setTo(nextTo);
              }}
            />
            <IconButton icon={<X size={16} strokeWidth={1.8} />} aria-label="Close" onClick={onClose} />
          </Toolbar>
        </header>

        <div className="rep-drawer-tabs">
          <Tabs
            aria-label="Member detail"
            value={tab}
            onChange={setTab}
            items={MEMBER_DRAWER_TABS}
          />
        </div>

        <div className={`rep-drawer-body rep-drawer-body--${tab}`}>
          {q.isError && <Banner status="danger">Couldn’t load member detail: {(q.error as Error).message}</Banner>}
          {q.isLoading && <SkeletonTable rows={7} />}
          {q.data && tab === 'reports' && (
            <TeamMemberReportsPanel
              member={q.data.member}
              tz={tz}
              onOpenModal={(modal) => onOpenModal({ ...modal, userId })}
            />
          )}
          {q.data && tab === 'approvals' && (
            <TeamMemberApprovalsPanel
              approvals={q.data.approvals}
              tz={tz}
              canDecide={canDecideApprovals}
              decisionError={decisionError}
              busyRequestId={decide.isPending ? decide.variables?.id ?? null : null}
              busyAction={decide.isPending ? decide.variables?.action ?? null : null}
              onApprove={(id) => decide.mutate({ id, action: 'approve' })}
              onReject={(id) => decide.mutate({ id, action: 'reject' })}
              onOpenDay={(date, req) => navigate({ to: '/edit-time', search: memberEditTimeSearch(date, userId, req) })}
            />
          )}
          {q.data && tab === 'profile' && (
            <TeamMemberProfilePanel profile={q.data.profile} timezone={tz} />
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function TeamMemberReportsPanel({
  member,
  tz,
  onOpenModal,
}: {
  member: TeamReportMember;
  tz: string;
  onOpenModal: (modal: ReportModalState) => void;
}) {
  const summary = useMemo(() => summarize(member.days), [member.days]);
  return (
    <div className="rep-drawer-stack rep-drawer-stack--reports">
      <div className="rep-drawer-stat-row">
        <DrawerMetric tone="lime" label="Worked" value={fmtDurationMs(member.workedMs)} />
        <DrawerMetric tone="cream" label="Approved hours" value={fmtDurationMs(member.manualMs)} />
        <DrawerMetric label="Starts" value={<StartCounts member={member} />} />
        <DrawerMetric label="Approvals" value={<ApprovalCounts member={member} />} />
        <DrawerMetric tone="mint" label="Activity" value={percentLabel(member.activityPercent)} />
      </div>
      <SelfReportTable days={member.days} loading={false} tz={tz} onOpenModal={onOpenModal} />
      {member.days.length === 0 && summary.approvalsTotal === 0 && (
        <EmptyState icon={<CalendarDays size={22} strokeWidth={1.8} />} title="No rows for this range" description="Try widening the date range." />
      )}
    </div>
  );
}

type DrawerMetricTone = 'lime' | 'cream' | 'mint' | 'pink';

function DrawerMetric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: DrawerMetricTone;
}) {
  const customValue = typeof value !== 'string' && typeof value !== 'number';
  return (
    <div className={`rep-drawer-metric${tone ? ` rep-drawer-metric--${tone}` : ''}`}>
      <span className="ui-t-eyebrow">{label}</span>
      <strong className={`ui-mono${customValue ? ' rep-drawer-metric-value--custom' : ''}`}>{value}</strong>
      {hint && <span className="ui-t-small">{hint}</span>}
    </div>
  );
}

function TeamMemberApprovalsPanel({
  approvals,
  tz,
  canDecide,
  decisionError,
  busyRequestId,
  busyAction,
  onApprove,
  onReject,
  onOpenDay,
}: {
  approvals: ManualTimeRequestDto[];
  tz: string;
  canDecide: boolean;
  decisionError: string | null;
  busyRequestId: string | null;
  busyAction: ApprovalDecisionAction | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onOpenDay: (date: string, req: ManualTimeRequestDto) => void;
}) {
  const [selectedApproval, setSelectedApproval] = useState<ManualTimeRequestDto | null>(null);
  const summary = useMemo(() => summarizeApprovalRows(approvals), [approvals]);
  if (approvals.length === 0) {
    return (
      <EmptyState
        icon={<Shield size={22} strokeWidth={1.8} />}
        title="No approvals in this range"
        description="Manual-time requests for the selected member will appear here."
      />
    );
  }

  return (
    <div className="rep-drawer-stack rep-drawer-stack--approvals">
      <div className="rep-drawer-stat-row">
        <DrawerMetric tone="cream" label="Pending" value={summary.pending} hint={fmtDurationMs(summary.pendingMs)} />
        <DrawerMetric tone="mint" label="Accepted" value={summary.approved} hint={fmtDurationMs(summary.approvedMs)} />
        <DrawerMetric tone="pink" label="Rejected" value={summary.rejected} hint={fmtDurationMs(summary.rejectedMs)} />
      </div>
      {decisionError && <Banner status="danger">Decision failed — {decisionError}</Banner>}
      <div className="rep-table-wrap">
        <Table density="compact" stickyHead className="rep-drawer-approvals-table">
          <THead>
            <Tr>
              <Th className="rep-drawer-apv-col-date">Date</Th>
              <Th className="rep-drawer-apv-col-time">Requested</Th>
              <Th className="rep-drawer-apv-col-status" align="center">Status</Th>
              <Th className="rep-drawer-apv-col-reason">Reason</Th>
              {canDecide && <Th className="rep-drawer-apv-col-actions" align="center">Action</Th>}
            </Tr>
          </THead>
          <Tbody>
            {approvals.map((req) => {
              const startMs = new Date(req.requestedStart).getTime();
              const endMs = new Date(req.requestedEnd).getTime();
              const date = dateKeyInTimeZone(startMs, tz);
              const decidedMs = req.decidedAt ? new Date(req.decidedAt).getTime() : null;
              const task = reportApprovalTask(req);
              const isBusy = busyRequestId === req.id;
              return (
                <Tr
                  key={req.id}
                  rail={approvalRail(req.status)}
                  className="rep-drawer-approval-row"
                  tabIndex={0}
                  aria-label={`View approval details for ${date}`}
                  onClick={() => setSelectedApproval(req)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedApproval(req);
                    }
                  }}
                >
                  <Td className="rep-drawer-apv-col-date">
                    <div className="rep-drawer-approval-date">
                      <span className="ui-t-strong">{fmtDayLabel(date)}</span>
                      <span className="ui-t-small ui-ink-3">{date}</span>
                    </div>
                  </Td>
                  <Td className="rep-drawer-apv-col-time">
                    <div className="rep-drawer-approval-time">
                      <span className="ui-mono">{fmtTime(startMs, tz)} - {fmtTime(endMs, tz)}</span>
                      <Tag mono>{fmtDurationMs(endMs - startMs)}</Tag>
                    </div>
                  </Td>
                  <Td className="rep-drawer-apv-col-status" align="center">
                    <div className="rep-drawer-approval-status">
                      <Tag status={approvalStatus(req.status)} mono>{approvalLabel(req.status)}</Tag>
                      <span className="ui-t-small ui-ink-3">
                        {approvalDecisionMeta(req, decidedMs)}
                      </span>
                    </div>
                  </Td>
                  <Td className="rep-drawer-apv-col-reason">
                    <div className="rep-drawer-approval-reason-row">
                      <div className="rep-drawer-approval-reason">
                        <span className="rep-drawer-approval-reason-main">{req.reason}</span>
                        <span className={`rep-drawer-approval-reason-meta ui-t-small${task.kind === 'missing' ? ' is-missing' : ''}`}>
                          {task.label}
                        </span>
                      </div>
                    </div>
                  </Td>
                  {canDecide && (
                    <Td className="rep-drawer-apv-col-actions" align="center">
                      <ReportApprovalDecisionCell
                        req={req}
                        busy={isBusy}
                        busyAction={isBusy ? busyAction : null}
                        onApprove={() => onApprove(req.id)}
                        onReject={() => onReject(req.id)}
                        onOpenDay={() => onOpenDay(date, req)}
                      />
                    </Td>
                  )}
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      </div>
      {selectedApproval && (
        <ReportApprovalDetailsModal
          req={selectedApproval}
          tz={tz}
          canDecide={canDecide}
          busy={busyRequestId === selectedApproval.id}
          busyAction={busyRequestId === selectedApproval.id ? busyAction : null}
          onApprove={(id) => {
            setSelectedApproval(null);
            onApprove(id);
          }}
          onReject={(id) => {
            setSelectedApproval(null);
            onReject(id);
          }}
          onClose={() => setSelectedApproval(null)}
          onOpenDay={(date, req) => {
            setSelectedApproval(null);
            onOpenDay(date, req);
          }}
        />
      )}
    </div>
  );
}

function ReportApprovalDecisionCell({
  req,
  busy,
  busyAction,
  onApprove,
  onReject,
  onOpenDay,
}: {
  req: ManualTimeRequestDto;
  busy: boolean;
  busyAction: ApprovalDecisionAction | null;
  onApprove: () => void;
  onReject: () => void;
  onOpenDay: () => void;
}) {
  if (req.status !== 'PENDING') {
    return (
      <div className="rep-drawer-approval-actions rep-drawer-approval-actions--done">
        <IconButton
          size="sm"
          variant="ghost"
          className="rep-drawer-approval-open-day"
          icon={<Clock4 size={13} strokeWidth={1.8} />}
          aria-label="Open Edit Time"
          title="Open day"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDay();
          }}
        />
      </div>
    );
  }
  return (
    <div className="rep-drawer-approval-actions">
      <Button
        size="sm"
        variant="danger"
        icon={<X size={13} strokeWidth={2} />}
        loading={busyAction === 'reject'}
        disabled={busy && busyAction !== 'reject'}
        onClick={(e) => {
          e.stopPropagation();
          onReject();
        }}
      >
        Reject
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon={<Check size={13} strokeWidth={2.2} />}
        loading={busyAction === 'approve'}
        disabled={busy && busyAction !== 'approve'}
        onClick={(e) => {
          e.stopPropagation();
          onApprove();
        }}
      >
        Approve
      </Button>
    </div>
  );
}

function ReportApprovalDetailsModal({
  req,
  tz,
  canDecide,
  busy,
  busyAction,
  onApprove,
  onReject,
  onClose,
  onOpenDay,
}: {
  req: ManualTimeRequestDto;
  tz: string;
  canDecide: boolean;
  busy: boolean;
  busyAction: ApprovalDecisionAction | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onClose: () => void;
  onOpenDay: (date: string, req: ManualTimeRequestDto) => void;
}) {
  if (typeof document === 'undefined') return null;

  const startMs = new Date(req.requestedStart).getTime();
  const endMs = new Date(req.requestedEnd).getTime();
  const date = dateKeyInTimeZone(startMs, tz);
  const decidedMs = req.decidedAt ? new Date(req.decidedAt).getTime() : null;
  const task = reportApprovalTask(req);

  return createPortal(
    <div className="rep-approval-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="rep-approval-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Approval detail for ${date}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rep-approval-detail-head">
          <div>
            <span className="ui-t-eyebrow">{date}</span>
            <h2 className="ui-t-title">Approval · {fmtDayLabel(date)}</h2>
          </div>
          <IconButton icon={<X size={16} strokeWidth={1.8} />} aria-label="Close" onClick={onClose} />
        </header>
        <div className="rep-approval-detail-body">
          <div className="rep-approval-detail-grid">
            <ReportApprovalDetailField label="Status">
              <Tag status={approvalStatus(req.status)} mono>{approvalLabel(req.status)}</Tag>
              <span className="ui-t-small ui-ink-3">{approvalDecisionMeta(req, decidedMs)}</span>
            </ReportApprovalDetailField>
            <ReportApprovalDetailField label="Requested">
              <span className="ui-mono">{fmtTime(startMs, tz)} - {fmtTime(endMs, tz)}</span>
              <Tag mono>{fmtDurationMs(endMs - startMs)}</Tag>
            </ReportApprovalDetailField>
            <ReportApprovalDetailField label="Task">
              <span className={task.kind === 'missing' ? 'rep-approval-detail-missing' : undefined}>{task.label}</span>
              {task.kind === 'missing' && <span className="ui-t-small ui-ink-3">No current task match</span>}
            </ReportApprovalDetailField>
            <ReportApprovalDetailField label="Reviewer">
              <span>{req.approver?.name ?? 'Workspace approver'}</span>
              {req.approver?.email && <span className="ui-t-small ui-ink-3">{req.approver.email}</span>}
            </ReportApprovalDetailField>
          </div>

          <section className="rep-approval-detail-section">
            <span className="ui-t-eyebrow">Reason</span>
            <p>{req.reason}</p>
          </section>

          {req.decidedReason && (
            <section className="rep-approval-detail-section">
              <span className="ui-t-eyebrow">Decision note</span>
              <p>{req.decidedReason}</p>
            </section>
          )}

          {task.reference && (
            <section className="rep-approval-detail-ref">
              <span className="ui-t-eyebrow">Task reference</span>
              <code>{task.reference}</code>
            </section>
          )}

          <div className="rep-approval-detail-foot">
            <Button
              size="sm"
              variant="secondary"
              icon={<Clock4 size={13} strokeWidth={1.8} />}
              onClick={() => onOpenDay(date, req)}
            >
              Open Edit Time
            </Button>
            {canDecide && req.status === 'PENDING' && (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<X size={13} strokeWidth={2} />}
                  loading={busyAction === 'reject'}
                  disabled={busy && busyAction !== 'reject'}
                  onClick={() => onReject(req.id)}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Check size={13} strokeWidth={2.2} />}
                  loading={busyAction === 'approve'}
                  disabled={busy && busyAction !== 'approve'}
                  onClick={() => onApprove(req.id)}
                >
                  Approve
                </Button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ReportApprovalDetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rep-approval-detail-field">
      <span className="ui-t-eyebrow">{label}</span>
      <div className="rep-approval-detail-field-value">{children}</div>
    </div>
  );
}

function TeamMemberProfilePanel({ profile, timezone }: { profile: SelfProfileResponse; timezone: string }) {
  const todayWindow = profile.shift ? formatScheduleRange(profile.shift.schedule[weekdayKey(new Date())]) : 'Day off';
  const workingDays = profile.shift ? countWorkingDays(profile.shift.schedule) : 0;
  const captureCount = [profile.policy.captureApps, profile.policy.captureTitles, profile.policy.captureUrls].filter(Boolean).length;
  return (
    <div className="rep-drawer-profile">
      <div className="rep-drawer-profile-head">
        <Identity
          avatar={<Avatar name={profile.user.name} size={40} />}
          name={profile.user.name}
          subtitle={profile.user.email}
        />
        <Tag mono>{friendlyRole(profile.user.displayRole)}</Tag>
      </div>

      <div className="rep-drawer-profile-grid">
        <ProfileFact icon={<Users size={16} strokeWidth={1.8} />} label="Team" value={profile.team?.name ?? 'Workspace-level'} detail={profile.team ? `${profile.team.memberCount} members` : 'No team assigned'} />
        <ProfileFact icon={<UserRound size={16} strokeWidth={1.8} />} label="Manager" value={profile.manager?.name ?? 'No direct manager'} detail={profile.manager?.email ?? 'Self scope'} />
        <ProfileFact icon={<SunMedium size={16} strokeWidth={1.8} />} label="Shift" value={profile.shift?.name ?? 'No shift'} detail={todayWindow} />
        <ProfileFact icon={<Clock4 size={16} strokeWidth={1.8} />} label="Weekly pattern" value={`${workingDays} working days`} detail={profile.shift ? `${profile.shift.bufferMin} min grace` : 'Full-day timeline'} />
        <ProfileFact icon={<Mail size={16} strokeWidth={1.8} />} label="Email" value={profile.user.email} detail={timezone.replace(/_/g, ' ')} />
        <ProfileFact icon={<Building2 size={16} strokeWidth={1.8} />} label="Workspace" value={profile.workspace.name} detail={`Member since ${formatLongDate(profile.user.createdAt)}`} />
        <ProfileFact icon={<Shield size={16} strokeWidth={1.8} />} label="Capture" value={`${captureCount}/3 enabled`} detail={`${profile.policy.retentionDaysScreenshots}d screenshot retention`} />
      </div>

      {profile.shift && (
        <div className="rep-drawer-week">
          {WEEKDAY_LABELS.map((day) => {
            const isToday = day.key === weekdayKey(new Date());
            return (
              <div key={day.key} className={`rep-drawer-week-day${isToday ? ' is-today' : ''}`}>
                <span className="ui-t-eyebrow">{day.label}</span>
                <span className="ui-mono">{formatScheduleRange(profile.shift?.schedule[day.key])}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProfileFact({ icon, label, value, detail }: { icon: ReactNode; label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="rep-profile-fact">
      <span className="rep-profile-fact__icon">{icon}</span>
      <div>
        <span className="ui-t-eyebrow">{label}</span>
        <strong>{value}</strong>
        <span className="ui-t-small">{detail}</span>
      </div>
    </div>
  );
}

function DateRangePicker({
  from,
  to,
  today,
  maxDays,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  maxDays: number;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState<string | null>(to);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(parseDateKey(from)));

  const months: [Date, Date] = [visibleMonth, addMonths(visibleMonth, 1)];

  function openPicker() {
    setDraftFrom(from);
    setDraftTo(to);
    setVisibleMonth(monthStart(parseDateKey(from)));
    setOpen((v) => !v);
  }

  function chooseDay(day: string) {
    if (!draftFrom || draftTo) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    if (Math.abs(daysBetween(draftFrom, day)) > maxDays - 1) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    const [nextFrom, nextTo] = compareDateKeys(day, draftFrom) < 0 ? [day, draftFrom] : [draftFrom, day];
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    onChange(nextFrom, nextTo);
    setOpen(false);
  }

  return (
    <div className="rep-date-range">
      <button
        type="button"
        className={`rep-date-trigger${open ? ' is-open' : ''}`}
        onClick={openPicker}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <CalendarDays size={15} strokeWidth={1.8} />
        <span>{formatRangeLabel(from, to)}</span>
      </button>

      {open && (
        <div className="rep-date-popover" role="dialog" aria-label="Report date range">
          <div className="rep-date-popover-head">
            <IconButton
              size="sm"
              icon={<ChevronLeft size={15} strokeWidth={1.8} />}
              aria-label="Previous month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
            />
            <span className="ui-t-eyebrow">{formatMonthRange(months[0], months[1])}</span>
            <IconButton
              size="sm"
              icon={<ChevronRight size={15} strokeWidth={1.8} />}
              aria-label="Next month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
            />
          </div>
          <div className="rep-calendars">
            {months.map((month) => (
              <CalendarMonth
                key={localDateKey(month)}
                month={month}
                today={today}
                draftFrom={draftFrom}
                draftTo={draftTo}
                maxDays={maxDays}
                onChoose={chooseDay}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarMonth({
  month,
  today,
  draftFrom,
  draftTo,
  maxDays,
  onChoose,
}: {
  month: Date;
  today: string;
  draftFrom: string;
  draftTo: string | null;
  maxDays: number;
  onChoose: (day: string) => void;
}) {
  const days = calendarCells(month);
  return (
    <section className="rep-calendar" aria-label={formatMonthLabel(month)}>
      <div className="rep-calendar-title">{formatMonthLabel(month)}</div>
      <div className="rep-calendar-weekdays" aria-hidden>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, index) => (
          <span key={`${d}-${index}`}>{d}</span>
        ))}
      </div>
      <div className="rep-calendar-days">
        {days.map((day, index) => {
          if (!day) return <span key={`blank-${index}`} aria-hidden />;
          const disabled = compareDateKeys(day, today) > 0 || (!draftTo && Math.abs(daysBetween(draftFrom, day)) > maxDays - 1);
          const selectedStart = day === draftFrom;
          const selectedEnd = day === draftTo;
          const inRange = draftTo ? compareDateKeys(day, draftFrom) >= 0 && compareDateKeys(day, draftTo) <= 0 : day === draftFrom;
          return (
            <button
              key={day}
              type="button"
              className={[
                'rep-calendar-day',
                inRange ? ' is-in-range' : '',
                selectedStart ? ' is-start' : '',
                selectedEnd ? ' is-end' : '',
                day === today ? ' is-today' : '',
              ].join('')}
              disabled={disabled}
              onClick={() => onChoose(day)}
              aria-label={formatFullDateLabel(day)}
              aria-pressed={inRange}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AppsPanel({ data }: { data: MemberReportDayAppsResponse }) {
  if (data.apps.length === 0) {
    return <EmptyState icon={<Rows3 size={22} strokeWidth={1.8} />} title="No app activity" description="No app minutes were captured for this day." />;
  }
  return (
    <div className="rep-apps-list">
      {data.apps.map((app) => (
        <div key={`${app.app}-${app.appBundle ?? ''}`} className="rep-app-row">
          <AppIcon name={app.app} iconUrl={app.iconUrl} />
          <div className="rep-app-row-main">
            <div className="rep-app-row-title">
              <span className="ui-t-strong">{app.app}</span>
              <span className="ui-t-small ui-ink-3">{app.appBundle ?? 'Unknown bundle'}</span>
            </div>
            <div className="rep-bar" aria-hidden>
              <span style={{ width: `${Math.max(2, app.share * 100)}%` }} />
            </div>
          </div>
          <div className="rep-app-row-metrics">
            <Tag mono>{app.minutes}m</Tag>
            <span className="ui-t-small">{Math.round(app.share * 100)}%</span>
            <span className="ui-t-small">{app.keystrokes} keys</span>
            <span className="ui-t-small">{app.clicks} clicks</span>
            <span className="ui-t-small">{app.scrolls} scrolls</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityPanel({ data, tz }: { data: MemberReportDayScreenshotsResponse; tz: string }) {
  const dayShell: DayInsight = {
    date: data.date,
    timezone: data.tz,
    dayStart: new Date(`${data.date}T00:00:00`).getTime(),
    dayEnd: new Date(`${data.date}T00:00:00`).getTime() + 24 * 60 * 60 * 1000,
    isFuture: false,
    isToday: data.date === localDateKey(),
    shift: null,
    firstActivityAt: null,
    lastActivityAt: null,
    totals: { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, pendingMs: 0, gapMs: 0 },
    blocks: [],
    recentRejected: [],
  };
  return (
    <div className="rep-activity-modal">
      <div className="rep-activity-head">
        <div>
          <span className="ui-t-eyebrow">Activity</span>
          <div className="rep-activity-score">{data.activityPercent === null ? '—' : `${data.activityPercent}%`}</div>
        </div>
        <Tag mono>{data.screenshots.length} screenshots</Tag>
      </div>
      {data.heatmap.buckets.length > 0 && (
        <ActivityHeatmap day={dayShell} heatmap={data.heatmap} />
      )}
      {data.screenshots.length === 0 ? (
        <EmptyState icon={<Images size={22} strokeWidth={1.8} />} title="No screenshots" description="No uploaded screenshots exist for this day yet." />
      ) : (
        <div className="rep-shot-grid">
          {data.screenshots.map((shot) => (
            <div key={shot.id} className="rep-shot">
              {shot.thumbUrl || shot.fullUrl ? (
                <a href={shot.fullUrl ?? shot.thumbUrl ?? undefined} target="_blank" rel="noreferrer" className="rep-shot-img">
                  <img src={shot.thumbUrl ?? shot.fullUrl ?? undefined} alt="" />
                  <ExternalLink size={14} strokeWidth={1.8} />
                </a>
              ) : (
                <div className="rep-shot-empty">
                  <Images size={20} strokeWidth={1.8} />
                </div>
              )}
              <div className="rep-shot-meta">
                <span className="ui-t-strong">{fmtTime(new Date(shot.capturedAt).getTime(), tz)}</span>
                <span className="ui-t-small ui-ink-2">{shot.activityPercent === null ? 'No activity sample' : `${shot.activityPercent}% activity`}</span>
                <span className="ui-t-small ui-ink-3">{shot.dominantApp ?? 'Unknown app'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportModal({
  title,
  subtitle,
  size = 'md',
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  children: ReactNode;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="rep-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`rep-modal rep-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rep-modal-head">
          <div>
            <span className="ui-t-eyebrow">{subtitle}</span>
            <h2 className="ui-t-title">{title}</h2>
          </div>
          <IconButton icon={<X size={16} strokeWidth={1.8} />} aria-label="Close" onClick={onClose} />
        </header>
        <div className="rep-modal-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function AppBadge({ app }: { app: { app: string; appBundle: string | null; iconUrl: string | null; minutes: number; share: number } }) {
  return (
    <span className="rep-app-badge">
      <AppIcon name={app.app} iconUrl={app.iconUrl} />
      <span>{app.app}</span>
    </span>
  );
}

function totalDayWorkedMs(day: MemberReportDay): number {
  return day.workedMs + day.meetingMs + day.manualMs;
}

function percentLabel(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function summarize(days: MemberReportDay[]) {
  let workedMs = 0;
  let manualMs = 0;
  let gapMs = 0;
  let gapCount = 0;
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  let activitySum = 0;
  let activityCount = 0;
  for (const d of days) {
    workedMs += totalDayWorkedMs(d);
    manualMs += d.manualMs;
    gapMs += d.gaps.totalMs;
    gapCount += d.gaps.count;
    approved += d.approvals.approved;
    pending += d.approvals.pending;
    rejected += d.approvals.rejected;
    if (d.activityPercent !== null) {
      activitySum += d.activityPercent;
      activityCount += 1;
    }
  }
  return {
    workedMs,
    manualMs,
    gapMs,
    gapCount,
    approved,
    pending,
    rejected,
    approvalsTotal: approved + pending + rejected,
    activityPercent: activityCount > 0 ? Math.round(activitySum / activityCount) : null,
  };
}

function summarizeApprovalRows(rows: ManualTimeRequestDto[]) {
  const out = {
    pending: 0,
    approved: 0,
    rejected: 0,
    pendingMs: 0,
    approvedMs: 0,
    rejectedMs: 0,
  };
  for (const row of rows) {
    const ms = new Date(row.requestedEnd).getTime() - new Date(row.requestedStart).getTime();
    if (row.status === 'PENDING') {
      out.pending += 1;
      out.pendingMs += ms;
    } else if (row.status === 'APPROVED') {
      out.approved += 1;
      out.approvedMs += ms;
    } else if (row.status === 'REJECTED') {
      out.rejected += 1;
      out.rejectedMs += ms;
    }
  }
  return out;
}

function approvalDecisionMeta(req: ManualTimeRequestDto, decidedMs: number | null) {
  if (req.status === 'CANCELLED') return 'Withdrawn';
  if (decidedMs) return `${fmtAgeShort(Date.now() - decidedMs)} decision`;
  return fmtAgeShort(Date.now() - new Date(req.createdAt).getTime());
}

function reportApprovalTask(req: ManualTimeRequestDto): { kind: 'current' | 'missing' | 'none'; label: string; reference: string | null } {
  if (req.taskSummary) {
    return { kind: 'current', label: req.taskSummary, reference: req.larkTaskGuid };
  }
  if (req.larkTaskGuid) {
    return { kind: 'missing', label: 'Task unavailable', reference: req.larkTaskGuid };
  }
  return { kind: 'none', label: 'Untracked', reference: null };
}

function memberEditTimeSearch(date: string, userId: string, req: ManualTimeRequestDto) {
  return {
    date,
    userId,
    requestId: req.id,
    focusStart: String(new Date(req.requestedStart).getTime()),
    focusEnd: String(new Date(req.requestedEnd).getTime()),
  };
}

function dateKeyInTimeZone(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date(ms).toISOString().slice(0, 10);
}

function approvalStatus(status: ManualTimeRequestDto['status']): Status {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'danger';
  if (status === 'PENDING') return 'warn';
  return 'neutral';
}

function approvalRail(status: ManualTimeRequestDto['status']): Rail | undefined {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'danger';
  if (status === 'PENDING') return 'warn';
  return undefined;
}

function approvalLabel(status: ManualTimeRequestDto['status']): string {
  if (status === 'APPROVED') return 'Accepted';
  if (status === 'REJECTED') return 'Rejected';
  if (status === 'PENDING') return 'Pending';
  return 'Cancelled';
}

function friendlyRole(role: SelfProfileResponse['user']['displayRole']) {
  if (role === 'ADMIN') return 'Admin';
  if (role === 'MANAGER') return 'Manager';
  return 'Member';
}

function weekdayKey(date: Date): Weekday {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()] as Weekday;
}

function formatScheduleRange(slot: ShiftSchedule[Weekday] | undefined) {
  if (!slot) return 'Day off';
  return `${formatShiftClock(slot.start)} - ${formatShiftClock(slot.end)}`;
}

function countWorkingDays(schedule: ShiftSchedule) {
  return WEEKDAY_LABELS.filter((day) => schedule[day.key] !== null).length;
}

function formatShiftClock(hhmm: string) {
  const [hourRaw, minuteRaw] = hhmm.split(':').map((part) => Number.parseInt(part, 10));
  const hour24 = hourRaw ?? 0;
  const minute = minuteRaw ?? 0;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatLongDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

function statusTag(status: ShiftStatus): Status {
  if (status === 'early' || status === 'on_time') return 'success';
  if (status === 'late') return 'danger';
  if (status === 'no_activity') return 'warn';
  return 'neutral';
}

function railForStatus(status: ShiftStatus): Rail | undefined {
  if (status === 'late') return 'danger';
  if (status === 'early' || status === 'on_time') return 'success';
  if (status === 'no_activity') return 'warn';
  return undefined;
}

function shiftLabel(status: ShiftStatus): string {
  if (status === 'on_time') return 'On time';
  if (status === 'no_shift') return 'No shift';
  if (status === 'no_activity') return 'No activity';
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function localDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(y!, m! - 1, d!);
}

function compareDateKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

function daysBetween(a: string, b: string): number {
  const start = parseDateKey(a).getTime();
  const end = parseDateKey(b).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function addLocalDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map((n) => Number.parseInt(n, 10));
  const date = new Date(y!, m! - 1, d! + delta);
  return localDateKey(date);
}

function calendarCells(month: Date): Array<string | null> {
  const start = monthStart(month);
  const firstDay = (start.getDay() + 6) % 7;
  const count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = Array.from({ length: firstDay }, () => null);
  for (let day = 1; day <= count; day += 1) {
    cells.push(localDateKey(new Date(start.getFullYear(), start.getMonth(), day)));
  }
  return cells;
}

function formatRangeLabel(from: string, to: string): string {
  return `${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
}

function formatShortDateLabel(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatFullDateLabel(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatMonthRange(first: Date, second: Date): string {
  return `${formatMonthLabel(first)} / ${formatMonthLabel(second)}`;
}

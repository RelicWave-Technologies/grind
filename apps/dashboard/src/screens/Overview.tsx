import './overview.css';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { Clock4, LayoutGrid, CalendarCheck, CloudOff } from 'lucide-react';
import { api } from '../lib/api';
import { fmtAgeShort } from '../lib/format';
import {
  Page,
  PageHeader,
  Toolbar,
  Button,
  Card,
  Stat,
  StatRow,
  List,
  ListRow,
  Tag,
  EmptyState,
  Banner,
  SkeletonStat,
  SkeletonTable,
} from '../ui';

/**
 * /overview — the MANAGER+ command center (M16). Composed entirely from the
 * shared "Quiet Datasheet" kit (src/ui/*): PageHeader for context, a flush
 * StatRow for today's headline numbers, Card + List for the attention queues
 * and the rejected ledger, Tag for status, Banner/EmptyState/Skeleton for the
 * loading/error/empty states. The page file contributes layout only — no
 * bespoke colour, type, border, or shadow (see overview.css).
 *
 * A single round-trip to /v1/admin/overview powers everything. For MEMBER the
 * `/` route redirects to /edit-time, so they never reach this surface.
 */

interface OverviewResponse {
  scope: 'team' | 'workspace';
  generatedAt: string;
  today: {
    date: string;
    tz: string;
    trackingUsers: number;
    activeUsers: number;
    totalUsers: number;
    workedHours: number;
    meetingHours: number;
    manualHours: number;
  };
  approvals: {
    pendingTotal: number;
    pendingStuck: number;
    oldestPendingAgeMs: number;
    recent: Array<{
      id: string;
      user: { id: string; name: string };
      reason: string;
      createdAt: string;
      ageMs: number;
      isStuck: boolean;
    }>;
  };
  /** People in scope whose Timo uploads are stuck / behind. Absent from older APIs. */
  agentSync?: {
    stuck: number;
    behind: number;
  };
  flags: {
    openTotal: number;
    recent: Array<{
      id: string;
      user: { id: string; name: string };
      type: string;
      windowStart: string;
      riskScore: number;
      count?: number;
      createdAt: string;
    }>;
  };
  recentRejected: Array<{
    id: string;
    user: { id: string; name: string };
    decidedAt: string | null;
    reason: string;
    decidedReason: string | null;
  }>;
}

export function OverviewScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const tz = me.workspaceTimezone;
  const q = useQuery({
    queryKey: ['admin', 'overview', tz],
    queryFn: () => api<OverviewResponse>(`/v1/admin/overview?tz=${encodeURIComponent(tz)}`),
    staleTime: 30_000,
  });

  const firstName = me.name.split(' ')[0] ?? 'there';
  const scopeLabel = q.data?.scope === 'workspace' ? 'this workspace' : 'your team';
  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  })
    .format(new Date())
    .toUpperCase();

  const t = q.data?.today;

  return (
    <Page>
      <PageHeader
        eyebrow={`${tz.replace(/_/g, ' ')} · ${dateLine}`}
        title={`Hi ${firstName} — here's ${scopeLabel} today`}
        subtitle={
          q.data
            ? `Live across ${scopeLabel}, generated ${fmtAgeShort(
                Date.now() - new Date(q.data.generatedAt).getTime(),
              )} ago. Approvals and flags need your eye.`
            : 'Assembling the command center — pulling today’s numbers, approvals and flags.'
        }
        actions={
          <Toolbar>
            <Button
              variant="ghost"
              size="sm"
              icon={<Clock4 size={15} strokeWidth={1.8} />}
              onClick={() => navigate({ to: '/edit-time' })}
            >
              Edit Time
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<LayoutGrid size={15} strokeWidth={1.8} />}
              onClick={() => navigate({ to: '/team' })}
            >
              Team Settings
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<CalendarCheck size={15} strokeWidth={1.8} />}
              onClick={() => navigate({ to: '/attendance' })}
            >
              Attendance
            </Button>
          </Toolbar>
        }
      />

      <div className="ov-sections">
        {q.isError && (
          <Banner status="danger">
            Couldn&apos;t load the overview: {(q.error as Error).message}
          </Banner>
        )}

        {/* Today's headline numbers */}
        <Card variant="flush" className="ui-rise-1">
          {!t && q.isError ? (
            // The banner above explains it; a skeleton here would spin forever.
            <StatRow>
              <Stat label="Today" value="—" />
            </StatRow>
          ) : q.isLoading || !t ? (
            <StatRow>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </StatRow>
          ) : (
            <StatRow>
              <Stat
                label="Tracking now"
                value={`${t.trackingUsers}`}
                unit={`/ ${t.totalUsers}`}
                hint={
                  t.trackingUsers === 0
                    ? 'paused users excluded'
                    : `${Math.round((t.trackingUsers / Math.max(1, t.totalUsers)) * 100)}% of people now`
                }
              />
              <Stat
                label="Tracked today"
                value={(t.workedHours + t.meetingHours).toFixed(1)}
                unit="h"
                hint={
                  t.meetingHours > 0
                    ? `${t.workedHours.toFixed(1)}h work + ${t.meetingHours.toFixed(1)}h meetings`
                    : 'across all tasks'
                }
              />
              <Stat
                label="Meeting time"
                value={t.meetingHours.toFixed(1)}
                unit="h"
                hint={
                  t.manualHours > 0
                    ? `+ ${t.manualHours.toFixed(1)}h manual`
                    : 'tracked in meetings'
                }
              />
              <Stat
                label="Manual time"
                value={t.manualHours.toFixed(1)}
                unit="h"
                hint={
                  t.manualHours === 0
                    ? 'all auto-tracked'
                    : `${Math.round((t.manualHours / Math.max(0.1, t.workedHours + t.meetingHours)) * 100)}% of tracked`
                }
              />
            </StatRow>
          )}
        </Card>

        {/* Timo sync — people whose tracked time is not reaching the server */}
        {q.data?.agentSync && (
          <SyncCard
            sync={q.data.agentSync}
            onOpen={(filter) => navigate({ to: '/users', search: filter ? { sync: filter } : {} })}
          />
        )}

        {/* Attention queues — pending approvals + open flags */}
        <div className="ov-queues ui-rise-2">
          <Card
            title="Pending approvals"
            action={
              <Toolbar>
                {q.data && q.data.approvals.pendingStuck > 0 && (
                  <Tag status="danger" mono>{`${q.data.approvals.pendingStuck} stuck`}</Tag>
                )}
                {q.data && (
                  <Tag status="neutral" mono>{`${q.data.approvals.pendingTotal}`}</Tag>
                )}
                <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/approvals' })}>
                  Open queue
                </Button>
              </Toolbar>
            }
          >
            {q.isLoading ? (
              <SkeletonTable rows={3} />
            ) : q.data && q.data.approvals.recent.length > 0 ? (
              <List>
                {q.data.approvals.recent.map((p) => (
                  <ListRow
                    key={p.id}
                    rail={p.isStuck ? 'danger' : 'warn'}
                    title={p.user.name}
                    subtitle={truncate(p.reason, 72)}
                    meta={fmtAgeShort(p.ageMs)}
                    trailing={
                      p.isStuck ? <Tag status="danger" dot>Stuck</Tag> : undefined
                    }
                    onClick={() => navigate({ to: '/approvals' })}
                  />
                ))}
              </List>
            ) : q.data ? (
              <EmptyState
                title="No pending approvals"
                description="Nothing waiting on you. Nice work."
              />
            ) : null}
          </Card>

          <Card
            title="Open flags"
            action={
              <Toolbar>
                {q.data && (
                  <Tag status="neutral" mono>{`${q.data.flags.openTotal}`}</Tag>
                )}
                <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/flags' })}>
                  Review flags
                </Button>
              </Toolbar>
            }
          >
            {q.isLoading ? (
              <SkeletonTable rows={3} />
            ) : q.data && q.data.flags.recent.length > 0 ? (
              <List>
                {q.data.flags.recent.map((f) => (
                  <ListRow
                    key={f.id}
                    rail="danger"
                    title={f.user.name}
                    subtitle={`${f.type.toLowerCase().replace(/_/g, ' ')}${f.count && f.count > 1 ? ` · ${f.count} minutes` : ''}`}
                    meta={fmtAgeShort(Date.now() - new Date(f.createdAt).getTime())}
                    trailing={<Tag status="danger" mono>{`risk ${f.riskScore}`}</Tag>}
                    onClick={() => navigate({ to: '/flags' })}
                  />
                ))}
              </List>
            ) : q.data ? (
              <EmptyState title="No open flags" description="No open risk flags." />
            ) : null}
          </Card>
        </div>

        {/* Recently rejected ledger */}
        {q.data && q.data.recentRejected.length > 0 && (
          <Card
            title="Recently rejected"
            action={<Tag status="neutral" mono>{`${q.data.recentRejected.length}`}</Tag>}
            className="ui-rise-3"
          >
            <List>
              {q.data.recentRejected.map((r) => (
                <ListRow
                  key={r.id}
                  title={r.user.name}
                  subtitle={
                    r.decidedReason
                      ? `${truncate(r.reason, 80)} — reviewer: ${truncate(r.decidedReason, 80)}`
                      : truncate(r.reason, 120)
                  }
                />
              ))}
            </List>
          </Card>
        )}
      </div>
    </Page>
  );
}

/**
 * "Timo sync stuck: N" — one row, linking to People filtered to whoever needs
 * a look (stuck first, else behind, else everyone).
 */
function SyncCard({
  sync,
  onOpen,
}: {
  sync: NonNullable<OverviewResponse['agentSync']>;
  onOpen: (filter: 'stuck' | 'behind' | null) => void;
}) {
  const filter = sync.stuck > 0 ? 'stuck' : sync.behind > 0 ? 'behind' : null;
  return (
    <Card variant="flush" className="ui-rise-2">
      <List>
        <ListRow
          rail={sync.stuck > 0 ? 'danger' : sync.behind > 0 ? 'warn' : 'success'}
          leading={<CloudOff size={16} strokeWidth={1.8} aria-hidden />}
          title={`Timo sync stuck: ${sync.stuck}`}
          subtitle={
            sync.stuck > 0
              ? 'Tracked time has waited on their laptop for hours, or keeps failing to upload.'
              : sync.behind > 0
                ? `${sync.behind} behind by more than 10 minutes — usually catches up on its own.`
                : 'Everyone’s tracked time is reaching the server.'
          }
          trailing={
            sync.stuck > 0 ? (
              <Tag status="danger" mono>{`${sync.stuck} stuck`}</Tag>
            ) : sync.behind > 0 ? (
              <Tag status="warn" mono>{`${sync.behind} behind`}</Tag>
            ) : (
              <Tag status="success" dot>All synced</Tag>
            )
          }
          onClick={() => onOpen(filter)}
        />
      </List>
    </Card>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

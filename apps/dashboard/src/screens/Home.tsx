import './home.css';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import {
  Clock4,
  LayoutGrid,
  Inbox,
  ShieldAlert,
  CalendarCheck,
  ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { isAdmin, isManagerOrAbove } from '../lib/auth';
import type { DayInsight } from '../lib/types';
import { fmtDurationMs, todayKey } from '../lib/format';
import {
  Page,
  PageHeader,
  Card,
  Stat,
  StatRow,
  List,
  ListRow,
  Button,
  Toolbar,
} from '../ui';

interface ListResponse<T> {
  requests?: T[];
  flags?: T[];
}

/**
 * Home — the personal landing screen, composed entirely from the shared
 * "Quiet Datasheet" kit (PageHeader, Card, Stat/StatRow, List/ListRow,
 * Button). It contributes layout only: no bespoke colour, type, border, or
 * shadow — those come from the kit + tokens. Greeting → today's personal
 * numbers as a hairline-divided StatRow → role-aware quick links as a List.
 *
 * MANAGER+ are redirected to /overview in the route's beforeLoad, so in
 * practice this is the MEMBER surface — but every role-aware branch is
 * preserved EXACTLY (presentation only). Each stat pulls from the same
 * endpoints the dedicated pages use, so a MEMBER seeing "0 approvals
 * waiting" actually reflects scope. The body staggers-rise on mount.
 *
 * Page-unique CSS lives in home.css and is pure layout, every class `hm-`.
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
  const approvalsQ = useQuery({
    queryKey: ['admin', 'mtr', 'PENDING'],
    enabled: isManagerOrAbove(me.role),
    queryFn: () => api<ListResponse<{ id: string }>>('/v1/admin/manual-time-requests?status=PENDING'),
  });
  const flagsQ = useQuery({
    queryKey: ['admin', 'flags', 'OPEN'],
    enabled: isManagerOrAbove(me.role),
    queryFn: () => api<ListResponse<{ id: string }>>('/v1/admin/flags?status=OPEN'),
  });

  const trackedMs = dayQ.data?.totals.workedMs ?? 0;
  const meetingMs = dayQ.data?.totals.meetingMs ?? 0;
  const manualMs = dayQ.data?.totals.manualMs ?? 0;
  const totalMs = trackedMs + meetingMs + manualMs;

  // Quick productivity from heatmap: avg of non-null buckets (0-100).
  const productivity = dayQ.data?.activity?.buckets
    ? avgNonNull(dayQ.data.activity.buckets)
    : null;

  const firstName = me.name.split(' ')[0] ?? 'there';
  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  })
    .format(new Date())
    .toUpperCase();

  const tracked = fmtHM(trackedMs);
  const manual = fmtHM(manualMs);

  const approvalsCount = approvalsQ.data?.requests?.length ?? 0;
  const flagsCount = flagsQ.data?.flags?.length ?? 0;

  return (
    <Page>
      <PageHeader
        eyebrow={`${partOfDay} · ${dateLine}`}
        title={`${firstName}, here's your day`}
        subtitle={
          totalMs > 0
            ? `You've tracked ${fmtDurationMs(totalMs)} today — keep the rhythm.`
            : 'No time tracked yet. Open the agent and start a task to begin.'
        }
        actions={
          <Toolbar>
            <Button
              variant="primary"
              icon={<Clock4 size={15} strokeWidth={2} />}
              onClick={() => navigate({ to: '/me-today' })}
            >
              My Day
            </Button>
            {isManagerOrAbove(me.role) && (
              <Button
                variant="secondary"
                icon={<LayoutGrid size={15} strokeWidth={2} />}
                onClick={() => navigate({ to: '/team' })}
              >
                Team
              </Button>
            )}
            {isManagerOrAbove(me.role) && (
              <Button
                variant="secondary"
                icon={<CalendarCheck size={15} strokeWidth={2} />}
                onClick={() => navigate({ to: '/attendance' })}
              >
                Attendance
              </Button>
            )}
          </Toolbar>
        }
      />

      {/* TODAY'S NUMBERS — hairline-divided StatRow in one flush card. */}
      <Card variant="flush" className="ui-rise-1">
        <StatRow>
          <Stat
            label="Productivity"
            value={productivity == null ? '—' : String(productivity)}
            unit={productivity == null ? undefined : '/100'}
            hint={
              productivity == null
                ? 'no samples yet'
                : productivity > 70
                  ? 'strong focus'
                  : productivity > 40
                    ? 'steady'
                    : 'quiet day'
            }
          />
          <Stat
            label="Tracked time"
            value={tracked.h}
            unit="h"
            hint={meetingMs > 0 ? `+ ${fmtDurationMs(meetingMs)} meetings` : 'across all tasks'}
          />
          {isManagerOrAbove(me.role) ? (
            <Stat
              label="Approvals waiting"
              value={String(approvalsCount)}
              hint={approvalsCount > 0 ? 'open in Approvals' : 'nothing waiting on you'}
            />
          ) : (
            <Stat label="Manual time" value={manual.h} unit="h" hint="approved manual entries" />
          )}
          {isManagerOrAbove(me.role) ? (
            <Stat
              label="Open flags"
              value={String(flagsCount)}
              hint={flagsCount > 0 ? 'review in Anti-cheat' : 'clean shop'}
            />
          ) : (
            <Stat label="Days present" value="—" hint="across the last week" />
          )}
        </StatRow>
      </Card>

      {/* QUICK LINKS — role-aware jump-offs as a lightweight List. */}
      <Card title="Jump back in" className="ui-rise-2">
        <List>
          <QuickLink
            icon={<Clock4 size={18} strokeWidth={1.9} />}
            title="My Day"
            sub="Today's ribbon, heatmap, and timesheet"
            onClick={() => navigate({ to: '/me-today' })}
          />
          {isManagerOrAbove(me.role) && (
            <QuickLink
              icon={<LayoutGrid size={18} strokeWidth={1.9} />}
              title="Team"
              sub="Heat-mapped users × days"
              onClick={() => navigate({ to: '/team' })}
            />
          )}
          {isManagerOrAbove(me.role) && (
            <QuickLink
              icon={<CalendarCheck size={18} strokeWidth={1.9} />}
              title="Attendance"
              sub="Present / absent + first-last times"
              onClick={() => navigate({ to: '/attendance' })}
            />
          )}
          {isManagerOrAbove(me.role) && (
            <QuickLink
              icon={<Inbox size={18} strokeWidth={1.9} />}
              title="Approvals"
              sub="Manual-time requests waiting"
              onClick={() => navigate({ to: '/approvals' })}
            />
          )}
          {isManagerOrAbove(me.role) && (
            <QuickLink
              icon={<ShieldAlert size={18} strokeWidth={1.9} />}
              title="Anti-cheat"
              sub="Open risk flags"
              onClick={() => navigate({ to: '/flags' })}
            />
          )}
          {isAdmin(me.role) && (
            <QuickLink
              icon={<LayoutGrid size={18} strokeWidth={1.9} />}
              title="Teams"
              sub="Create, rename, assign managers"
              onClick={() => navigate({ to: '/teams' })}
            />
          )}
        </List>
      </Card>
    </Page>
  );
}

function QuickLink({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <ListRow
      leading={<span className="hm-link-icon">{icon}</span>}
      title={title}
      subtitle={sub}
      trailing={<ChevronRight size={16} strokeWidth={2} className="hm-link-chevron" />}
      onClick={onClick}
    />
  );
}

function fmtHM(ms: number): { h: string; m: string } {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return { h: String(h), m: String(m).padStart(2, '0') };
}

function avgNonNull(arr: Array<number | null>): number {
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (v !== null) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? 0 : Math.round(s / n);
}

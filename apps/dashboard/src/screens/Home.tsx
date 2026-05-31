import { useQuery } from '@tanstack/react-query';
import { Link, useRouteContext } from '@tanstack/react-router';
import { Clock4, LayoutGrid, Inbox, ShieldAlert, CalendarCheck, ArrowRight, Activity } from 'lucide-react';
import { api } from '../lib/api';
import { isAdmin, isManagerOrAbove } from '../lib/auth';
import type { DayInsight } from '../lib/types';
import { fmtDurationMs, todayKey } from '../lib/format';

interface ListResponse<T> {
  requests?: T[];
  flags?: T[];
}

/**
 * Premium Home — near-black violet-glow hero, then a stat row of today's
 * numbers, then a per-role action grid. The hero greeting and metrics
 * stagger-rise on mount per docs §2 motion.
 *
 * Each stat pulls from the same endpoints the dedicated pages use, so a
 * MEMBER seeing "0 approvals waiting" actually reflects scope.
 */
export function HomeScreen() {
  const { me } = useRouteContext({ from: '/authed' });
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

  return (
    <div className="page page-wide">
      {/* HERO — staggered on mount */}
      <section className="hero rise rise-1">
        <div>
          <div className="hero-greeting">{partOfDay}</div>
          <h1 className="hero-title">{firstName}, here&apos;s your day.</h1>
          <p className="hero-sub">
            {totalMs > 0
              ? `You’ve tracked ${fmtDurationMs(totalMs)} today — keep the rhythm.`
              : 'No time tracked yet. Open the agent and start a task to begin.'}
          </p>
        </div>
        <div className="hero-meta">
          <span className="hero-meta-label">Tracked today</span>
          <span className="hero-meta-value">
            {Math.floor(trackedMs / 3_600_000)}
            <span className="unit">h</span>
            {' '}
            {Math.floor((trackedMs % 3_600_000) / 60_000)}
            <span className="unit">m</span>
          </span>
        </div>
      </section>

      {/* STAT GRID */}
      <section className="stat-grid rise rise-2" style={{ marginTop: 'var(--sp-7)' }}>
        <StatCard
          chipClass="stat-chip-violet"
          icon={<Activity size={18} strokeWidth={2} />}
          label="Productivity"
          value={productivity == null ? '—' : `${productivity}`}
          unit={productivity == null ? '' : '/100'}
          foot={productivity == null ? 'No samples yet' : productivity > 70 ? 'Strong focus' : productivity > 40 ? 'Steady' : 'Quiet day'}
        />
        <StatCard
          chipClass="stat-chip-green"
          icon={<Clock4 size={18} strokeWidth={2} />}
          label="Tracked time"
          value={fmtHM(trackedMs).h}
          unit="h"
          afterValue={<><span className="display" style={{ fontSize: 30, fontWeight: 700 }}>{fmtHM(trackedMs).m}</span><span className="unit">m</span></>}
          foot={meetingMs > 0 ? `+ ${fmtDurationMs(meetingMs)} meetings` : 'Across all tasks'}
        />
        {isManagerOrAbove(me.role) ? (
          <StatCard
            chipClass="stat-chip-amber"
            icon={<Inbox size={18} strokeWidth={2} />}
            label="Approvals waiting"
            value={`${approvalsQ.data?.requests?.length ?? 0}`}
            foot={(approvalsQ.data?.requests?.length ?? 0) > 0 ? 'Open in Approvals' : 'Nothing waiting on you'}
            href="/approvals"
          />
        ) : (
          <StatCard
            chipClass="stat-chip-amber"
            icon={<Inbox size={18} strokeWidth={2} />}
            label="Manual time"
            value={fmtHM(manualMs).h}
            unit="h"
            afterValue={<><span className="display" style={{ fontSize: 30, fontWeight: 700 }}>{fmtHM(manualMs).m}</span><span className="unit">m</span></>}
            foot="Approved manual entries"
          />
        )}
        {isManagerOrAbove(me.role) ? (
          <StatCard
            chipClass="stat-chip-rose"
            icon={<ShieldAlert size={18} strokeWidth={2} />}
            label="Open flags"
            value={`${flagsQ.data?.flags?.length ?? 0}`}
            foot={(flagsQ.data?.flags?.length ?? 0) > 0 ? 'Review in Anti-cheat' : 'Clean shop'}
            href="/flags"
          />
        ) : (
          <StatCard
            chipClass="stat-chip-blue"
            icon={<CalendarCheck size={18} strokeWidth={2} />}
            label="Days present"
            value="—"
            foot="Across the last week"
          />
        )}
      </section>

      {/* QUICK NAV */}
      <section className="quick-grid rise rise-3" style={{ marginTop: 'var(--sp-7)' }}>
        <QuickLink to="/me-today" icon={<Clock4 size={18} strokeWidth={2} />} title="My Day" sub="Today’s ribbon, heatmap, and timesheet" />
        {isManagerOrAbove(me.role) && (
          <QuickLink to="/team" icon={<LayoutGrid size={18} strokeWidth={2} />} title="Team" sub="Heat-mapped users × days" />
        )}
        {isManagerOrAbove(me.role) && (
          <QuickLink to="/attendance" icon={<CalendarCheck size={18} strokeWidth={2} />} title="Attendance" sub="Present / absent + first-last times" />
        )}
        {isManagerOrAbove(me.role) && (
          <QuickLink to="/approvals" icon={<Inbox size={18} strokeWidth={2} />} title="Approvals" sub="Manual-time requests waiting" />
        )}
        {isManagerOrAbove(me.role) && (
          <QuickLink to="/flags" icon={<ShieldAlert size={18} strokeWidth={2} />} title="Anti-cheat" sub="Open risk flags" />
        )}
        {isAdmin(me.role) && (
          <QuickLink to="/teams" icon={<LayoutGrid size={18} strokeWidth={2} />} title="Teams" sub="Create, rename, assign managers" />
        )}
      </section>
    </div>
  );
}

interface StatProps {
  chipClass: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  afterValue?: React.ReactNode;
  foot?: string;
  href?: string;
}
function StatCard({ chipClass, icon, label, value, unit, afterValue, foot, href }: StatProps) {
  const inner = (
    <>
      <div className="stat-head">
        <div className={`stat-chip ${chipClass}`} aria-hidden>{icon}</div>
        <div className="stat-label">{label}</div>
      </div>
      <div className="stat-value">
        {value}
        {unit && <span className="unit">{unit}</span>}
        {afterValue && <> {afterValue}</>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </>
  );
  if (href) {
    return <Link to={href} className="stat card-interactive" style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link>;
  }
  return <div className="stat">{inner}</div>;
}

function QuickLink({ to, icon, title, sub }: { to: string; icon: React.ReactNode; title: string; sub: string }) {
  return (
    <Link to={to} className="quick-card card-interactive">
      <div className="quick-icon" aria-hidden>{icon}</div>
      <div className="quick-meta">
        <div className="quick-title">{title}</div>
        <div className="quick-sub">{sub}</div>
      </div>
      <ArrowRight size={14} strokeWidth={2.2} className="quick-arrow" />
    </Link>
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

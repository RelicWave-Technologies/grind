import { useQuery } from '@tanstack/react-query';
import { Link, useRouteContext } from '@tanstack/react-router';
import {
  Inbox,
  ShieldAlert,
  Users,
  Clock4,
  Activity,
  ArrowRight,
  AlertTriangle,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { fmtDurationMs, fmtAgeShort } from '../lib/format';

/**
 * /overview — MANAGER+ command center (M16).
 *
 * Single round-trip to /v1/admin/overview powers everything on this
 * screen: today's tracked totals, who's actively tracking, what's
 * stuck waiting on approval, recent flags, recent rejections.
 *
 * For MEMBER, the / route redirects to /me-today instead — they never
 * see this surface.
 */

interface OverviewResponse {
  scope: 'team' | 'workspace';
  generatedAt: string;
  today: {
    date: string;
    tz: string;
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
  flags: {
    openTotal: number;
    recent: Array<{
      id: string;
      user: { id: string; name: string };
      type: string;
      windowStart: string;
      riskScore: number;
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
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const q = useQuery({
    queryKey: ['admin', 'overview', tz],
    queryFn: () => api<OverviewResponse>(`/v1/admin/overview?tz=${encodeURIComponent(tz)}`),
    staleTime: 30_000,
  });

  const firstName = me.name.split(' ')[0] ?? 'there';
  const scopeLabel = q.data?.scope === 'workspace' ? 'this workspace' : 'your team';

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1">Overview</h1>
          <p className="secondary page-sub">
            {q.data
              ? `Today across ${scopeLabel} — generated ${fmtAgeShort(Date.now() - new Date(q.data.generatedAt).getTime())}`
              : `Hi ${firstName} — loading the command center…`}
          </p>
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading overview…</div>}
      {q.isError && (
        <div className="card empty empty-error">
          Couldn&apos;t load: {(q.error as Error).message}
        </div>
      )}

      {q.data && (
        <>
          <section className="stat-grid rise rise-1" style={{ marginTop: 'var(--sp-5)' }}>
            <StatTile
              chip="stat-chip-violet"
              icon={<Users size={18} strokeWidth={2} />}
              label="Active today"
              value={`${q.data.today.activeUsers}`}
              after={<span className="unit">/ {q.data.today.totalUsers}</span>}
              foot={
                q.data.today.activeUsers === 0
                  ? 'Nobody has tracked time yet'
                  : `${Math.round((q.data.today.activeUsers / Math.max(1, q.data.today.totalUsers)) * 100)}% of people`
              }
            />
            <StatTile
              chip="stat-chip-green"
              icon={<Clock4 size={18} strokeWidth={2} />}
              label="Tracked"
              value={q.data.today.workedHours.toFixed(1)}
              after={<span className="unit">h</span>}
              foot={
                q.data.today.meetingHours > 0
                  ? `+ ${q.data.today.meetingHours.toFixed(1)}h meetings`
                  : 'Across all tasks'
              }
            />
            <StatTile
              chip="stat-chip-amber"
              icon={<Inbox size={18} strokeWidth={2} />}
              label="Pending approvals"
              value={`${q.data.approvals.pendingTotal}`}
              after={
                q.data.approvals.pendingStuck > 0 ? (
                  <span className="stat-warn">
                    <AlertTriangle size={11} strokeWidth={2.4} /> {q.data.approvals.pendingStuck} stuck
                  </span>
                ) : null
              }
              foot={
                q.data.approvals.pendingTotal === 0
                  ? 'Nothing waiting'
                  : `Oldest ${fmtAgeShort(q.data.approvals.oldestPendingAgeMs)}`
              }
              href="/approvals"
            />
            <StatTile
              chip="stat-chip-rose"
              icon={<ShieldAlert size={18} strokeWidth={2} />}
              label="Open flags"
              value={`${q.data.flags.openTotal}`}
              foot={q.data.flags.openTotal === 0 ? 'Clean shop' : 'Anti-cheat review'}
              href="/flags"
            />
          </section>

          <section className="overview-row rise rise-2" style={{ marginTop: 'var(--sp-6)' }}>
            <Card title="Recent pending approvals" linkTo="/approvals" linkLabel="See all">
              {q.data.approvals.recent.length === 0 ? (
                <Empty msg="Nothing waiting on you. Nice work." />
              ) : (
                <ul className="overview-list" role="list">
                  {q.data.approvals.recent.map((p) => (
                    <li key={p.id} className="overview-row-item">
                      <div className="overview-row-text">
                        <span className="overview-row-name">{p.user.name}</span>
                        <span className="overview-row-sub">{truncate(p.reason, 80)}</span>
                      </div>
                      <span className={`age-chip${p.isStuck ? ' is-stuck' : ''}`}>
                        {p.isStuck && <AlertTriangle size={10} strokeWidth={2.4} />}
                        {fmtAgeShort(p.ageMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Recent flags" linkTo="/flags" linkLabel="Review">
              {q.data.flags.recent.length === 0 ? (
                <Empty msg="No open risk flags." />
              ) : (
                <ul className="overview-list" role="list">
                  {q.data.flags.recent.map((f) => (
                    <li key={f.id} className="overview-row-item">
                      <div className="overview-row-text">
                        <span className="overview-row-name">{f.user.name}</span>
                        <span className="overview-row-sub">
                          <span className="flag-type-chip">{f.type.toLowerCase().replace('_', ' ')}</span>{' '}
                          <span className="tertiary">risk {f.riskScore}/100</span>
                        </span>
                      </div>
                      <span className="age-chip">{fmtAgeShort(Date.now() - new Date(f.createdAt).getTime())}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {q.data.recentRejected.length > 0 && (
            <section className="card rise rise-3" style={{ marginTop: 'var(--sp-5)', padding: 'var(--sp-6)' }}>
              <header className="overview-card-head">
                <h2 className="h3" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <XCircle size={15} strokeWidth={2} /> Recently rejected
                </h2>
                <span className="secondary callout">Last {q.data.recentRejected.length}</span>
              </header>
              <ul className="overview-list" role="list">
                {q.data.recentRejected.map((r) => (
                  <li key={r.id} className="overview-row-item">
                    <div className="overview-row-text">
                      <span className="overview-row-name">{r.user.name}</span>
                      <span className="overview-row-sub">{truncate(r.reason, 80)}</span>
                      {r.decidedReason && (
                        <span className="small tertiary">Reviewer: {truncate(r.decidedReason, 80)}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="overview-row rise rise-3" style={{ marginTop: 'var(--sp-6)' }}>
            <QuickLink
              to="/me-today"
              icon={<Activity size={18} strokeWidth={2} />}
              title="My Day"
              sub="Your own tracked day"
            />
            <QuickLink
              to="/team"
              icon={<Users size={18} strokeWidth={2} />}
              title="Team timesheets"
              sub="Heat-mapped users × days"
            />
            <QuickLink
              to="/attendance"
              icon={<Clock4 size={18} strokeWidth={2} />}
              title="Attendance"
              sub="Present / absent + first-last times"
            />
          </section>
        </>
      )}
    </div>
  );
}

function StatTile({
  chip,
  icon,
  label,
  value,
  after,
  foot,
  href,
}: {
  chip: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  after?: React.ReactNode;
  foot?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="stat-head">
        <div className={`stat-chip ${chip}`} aria-hidden>{icon}</div>
        <div className="stat-label">{label}</div>
      </div>
      <div className="stat-value">
        {value}
        {after && <> {after}</>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </>
  );
  if (href) {
    return (
      <Link to={href} className="stat card-interactive" style={{ textDecoration: 'none', color: 'inherit' }}>
        {inner}
      </Link>
    );
  }
  return <div className="stat">{inner}</div>;
}

function Card({
  title,
  linkTo,
  linkLabel,
  children,
}: {
  title: string;
  linkTo?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overview-card" style={{ padding: 'var(--sp-6)' }}>
      <header className="overview-card-head">
        <h2 className="h3">{title}</h2>
        {linkTo && linkLabel && (
          <Link to={linkTo} className="btn-ghost small">
            {linkLabel} <ArrowRight size={12} strokeWidth={2.2} />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="tertiary" style={{ padding: 'var(--sp-3) 0' }}>{msg}</div>;
}

function QuickLink({
  to,
  icon,
  title,
  sub,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
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

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

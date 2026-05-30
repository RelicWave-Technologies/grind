import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ListTodo, PieChart, Settings as SettingsIcon, LogOut, Timer, Gauge, Clock, Keyboard, MousePointer2, CalendarRange } from 'lucide-react';
import Today from './Today';
import Tasks from './Tasks';
import EditTime from './EditTime';
import Settings from './Settings';
import LineChart from '../components/LineChart';
import ScreenshotGrid from '../components/ScreenshotGrid';

type Tab = 'today' | 'editTime' | 'tasks' | 'reports' | 'settings';

const NAV: { id: Tab; label: string; icon: typeof CalendarClock }[] = [
  { id: 'today', label: 'Today', icon: CalendarClock },
  { id: 'editTime', label: 'Edit Time', icon: CalendarRange },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'reports', label: 'Reports', icon: PieChart },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export default function MainLayout() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('today');

  const logout = useMutation({
    mutationFn: () => window.agent.auth.logout(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['authStatus'] }),
  });

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="brand-mark"><Timer size={15} strokeWidth={2.5} /></span>
          <span className="brand-name">Grind</span>
        </div>

        <nav className="nav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              <Icon size={18} strokeWidth={2} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <button className="sidebar-user" onClick={() => logout.mutate()} title="Sign out">
          <span className="avatar">A</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="callout" style={{ display: 'block', fontWeight: 600 }}>Account</span>
            <span className="small secondary">Sign out</span>
          </span>
          <LogOut size={16} strokeWidth={2} color="var(--label-tertiary)" />
        </button>
      </aside>

      <main className="content">
        {tab === 'today' && <Today />}
        {tab === 'editTime' && <EditTime />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'reports' && <Reports />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}

function fmtHM(min: number): { h: number; m: number } {
  return { h: Math.floor(min / 60), m: min % 60 };
}

function Reports() {
  const insights = useQuery({ queryKey: ['insightsToday'], queryFn: () => window.agent.insights.today(), refetchInterval: 15_000 });
  const allShots = useQuery({ queryKey: ['shotsAll'], queryFn: () => window.agent.screenshots.recent(200), refetchInterval: 10_000 });
  const d = insights.data;
  const tracked = fmtHM(d?.score.trackedMinutes ?? 0);

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todayShots = (allShots.data ?? []).filter((s) => s.capturedAt >= startOfDay.getTime());

  // Build a daytime chart (7a–9p) from the hourly keystroke+click counts.
  const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7..21
  const points = HOURS.map((h) => d?.byHour?.[h] ?? 0);
  const labels = HOURS.map((h) => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'a' : 'p'));
  const hasData = (d?.score.trackedMinutes ?? 0) > 0;

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Productivity</span>
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          <div className="stat-grid rise rise-1">
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: 'var(--violet)' }}><Gauge size={17} /></span>
                <span className="stat-label">Productivity</span>
              </div>
              <div className="stat-value">{d?.score.score ?? 0}<span className="unit"> /100</span></div>
            </div>
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: 'var(--c-green)' }}><Clock size={17} /></span>
                <span className="stat-label">Active time</span>
              </div>
              <div className="stat-value">{tracked.h}<span className="unit">h </span>{tracked.m}<span className="unit">m</span></div>
            </div>
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: 'var(--c-slate)' }}><Keyboard size={17} /></span>
                <span className="stat-label">Keystrokes</span>
              </div>
              <div className="stat-value">{(d?.totals.keystrokes ?? 0).toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: '#5aa9ff' }}><MousePointer2 size={17} /></span>
                <span className="stat-label">Clicks</span>
              </div>
              <div className="stat-value">{(d?.totals.clicks ?? 0).toLocaleString()}</div>
            </div>
          </div>

          <div className="section-head"><span className="section-title">Activity by hour</span></div>
          {hasData ? (
            <div className="chart-card rise rise-2">
              <LineChart points={points} labels={labels} />
            </div>
          ) : (
            <div className="empty rise rise-2">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <PieChart size={26} strokeWidth={2} />
              </span>
              <div className="h3">No activity yet today</div>
              <div className="callout secondary">Keystroke &amp; mouse activity appears once you track with Accessibility enabled.</div>
            </div>
          )}

          <div className="section-head">
            <span className="section-titlewrap"><span className="section-title">Screenshots</span><span className="section-aside">{todayShots.length} today</span></span>
          </div>
          {todayShots.length > 0 ? (
            <ScreenshotGrid shots={todayShots} />
          ) : (
            <div className="shot-empty callout secondary">No screenshots captured today yet.</div>
          )}
        </div>
      </div>
    </>
  );
}

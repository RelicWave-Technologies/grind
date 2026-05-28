import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, FolderKanban, PieChart, Settings as SettingsIcon, LogOut, Timer, CheckCircle2, Clock } from 'lucide-react';
import Today from './Today';
import Projects from './Projects';
import Settings from './Settings';
import LineChart from '../components/LineChart';

type Tab = 'today' | 'projects' | 'reports' | 'settings';

const NAV: { id: Tab; label: string; icon: typeof CalendarClock }[] = [
  { id: 'today', label: 'Today', icon: CalendarClock },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
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
        {tab === 'projects' && <Projects />}
        {tab === 'reports' && <Reports />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}

function Reports() {
  const [range, setRange] = useState<'day' | 'week'>('day');
  const dayPts = [0.4, 0.7, 0.9, 1.1, 1.6, 1.3, 0.9, 1.0, 1.5];
  const dayLabels = ['8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p'];
  const weekPts = [3.2, 5.1, 4.4, 6.2, 5.6, 2.1, 1.2];
  const weekLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Productivity</span>
        <div className="segmented no-drag">
          <button className={`seg${range === 'day' ? ' active' : ''}`} onClick={() => setRange('day')}>Day</button>
          <button className={`seg${range === 'week' ? ' active' : ''}`} onClick={() => setRange('week')}>Week</button>
        </div>
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          <div className="stat-grid rise rise-1">
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: 'var(--c-green)' }}><CheckCircle2 size={18} /></span>
                <span className="stat-label">Sessions<br />completed</span>
              </div>
              <div className="stat-value">12</div>
            </div>
            <div className="stat">
              <div className="stat-top">
                <span className="stat-chip" style={{ background: 'var(--violet)' }}><Clock size={18} /></span>
                <span className="stat-label">Time<br />tracked</span>
              </div>
              <div className="stat-value">1<span className="unit">h </span>46<span className="unit">m</span></div>
            </div>
          </div>

          <div className="chart-card rise rise-2">
            <LineChart
              points={range === 'day' ? dayPts : weekPts}
              labels={range === 'day' ? dayLabels : weekLabels}
            />
          </div>

          <div className="small tertiary" style={{ textAlign: 'center', marginTop: 16 }}>
            Sample data — live reporting arrives with the dashboard milestone.
          </div>
        </div>
      </div>
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Clock, Gauge, Keyboard, MousePointer2, PieChart } from 'lucide-react';
import LineChart from '../components/LineChart';
import ScreenshotGrid from '../components/ScreenshotGrid';
import { useWorkspaceTime, workspaceTimeReady } from '../lib/workspaceTime';

function fmtHM(min: number): { h: number; m: number } {
  return { h: Math.floor(min / 60), m: min % 60 };
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return `${hour % 12}${hour < 12 ? 'a' : 'p'}`;
}

/** Your day in numbers: productivity, active time, input counts, activity by hour, today's screenshots. */
export default function MyDay() {
  const insights = useQuery({ queryKey: ['insightsToday'], queryFn: () => window.agent.insights.today(), refetchInterval: 15_000 });
  const allShots = useQuery({ queryKey: ['shotsAll'], queryFn: () => window.agent.screenshots.recent(200) });
  const workspaceTime = useWorkspaceTime();
  const d = insights.data;
  const tracked = fmtHM(d?.score.trackedMinutes ?? 0);

  const timeContext = workspaceTime.data;
  const hasWorkspaceTime = workspaceTimeReady(timeContext);
  const timeZone = hasWorkspaceTime ? timeContext.timeZone : null;
  const todayShots = hasWorkspaceTime
    ? (allShots.data ?? []).filter((shot) => shot.capturedAt >= timeContext.dayStart && shot.capturedAt < timeContext.dayEnd)
    : [];

  // The backend returns workspace-local hourly buckets for the whole day.
  // Keep the full 24-hour frame visible so early/late activity is not hidden.
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const points = HOURS.map((h) => d?.byHour?.[h] ?? 0);
  const labels = HOURS.map((h) => (h % 4 === 0 ? formatHourLabel(h) : ''));
  const hasData = (d?.score.trackedMinutes ?? 0) > 0;

  return (
    <div className="myday">
      <div className="stat-grid stat-grid--two">
        <div className="stat">
          <div className="stat-top"><span className="stat-chip"><Gauge size={17} /></span><span className="stat-label">Productivity</span></div>
          <div className="stat-value">{d?.score.score ?? 0}<span className="unit"> /100</span></div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-chip"><Clock size={17} /></span><span className="stat-label">Active time</span></div>
          <div className="stat-value">{tracked.h}<span className="unit">h </span>{tracked.m}<span className="unit">m</span></div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-chip"><Keyboard size={17} /></span><span className="stat-label">Keystrokes</span></div>
          <div className="stat-value">{(d?.totals.keystrokes ?? 0).toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-chip"><MousePointer2 size={17} /></span><span className="stat-label">Clicks</span></div>
          <div className="stat-value">{(d?.totals.clicks ?? 0).toLocaleString()}</div>
        </div>
      </div>

      <div className="section-head"><span className="section-title">Activity by hour</span></div>
      {hasData ? (
        <div className="chart-card">
          <LineChart points={points} labels={labels} />
        </div>
      ) : (
        <div className="empty">
          <span className="empty-icon"><PieChart size={26} strokeWidth={2} /></span>
          <div className="h3">No activity yet today</div>
          <div className="callout secondary">Keystroke &amp; mouse activity appears once you track with Accessibility enabled.</div>
        </div>
      )}

      <div className="section-head">
        <span className="section-titlewrap">
          <span className="section-title">Screenshots</span>
          <span className="section-aside">{hasWorkspaceTime ? `${todayShots.length} today` : 'Syncing time…'}</span>
        </span>
      </div>
      {todayShots.length > 0 && timeZone ? (
        <ScreenshotGrid shots={todayShots} timeZone={timeZone} />
      ) : (
        <div className="shot-empty callout secondary">No screenshots captured today yet.</div>
      )}
    </div>
  );
}

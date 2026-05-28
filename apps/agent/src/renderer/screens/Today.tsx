import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play, Pause, Square, Clock } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import DayTimeline from '../components/DayTimeline';
import ScreenshotsStrip from '../components/ScreenshotsStrip';

export function fmtClock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function Legend() {
  return (
    <div className="dt-legend">
      <span><i className="dt-dot" style={{ background: 'var(--violet)' }} /> Work</span>
      <span><i className="dt-dot" style={{ background: 'var(--c-blue)' }} /> Meeting</span>
      <span><i className="dt-dot" style={{ background: 'rgba(40,36,56,0.18)' }} /> Idle</span>
    </div>
  );
}

export default function Today() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => window.agent.projects.list() });
  const today = useQuery({
    queryKey: ['today'],
    queryFn: () => window.agent.timer.today(),
    refetchInterval: 3000,
  });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE' });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void window.agent.timer.status().then((s) => alive && setTimer(s));
    const off = window.agent.timer.onStatusChange((s) => {
      setTimer(s);
      setNow(Date.now());
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(tick);
    };
  }, []);

  const start = useMutation({
    mutationFn: (projectId: string) => window.agent.timer.start(projectId),
    onSuccess: (s) => setTimer(s),
  });
  const stop = useMutation({
    mutationFn: () => window.agent.timer.stop(),
    onSuccess: (s) => setTimer(s),
  });

  const running = timer.state === 'RUNNING' ? timer : null;
  const runningProject = running ? projects.data?.find((p) => p.id === running.projectId) : undefined;
  const entries = today.data ?? [];

  if (running) {
    const st = runningProject ? projectStyle(runningProject.id) : null;
    return (
      <>
        <div className="toolbar drag" />
        <div className="content-scroll center-y">
          <div className="content-narrow focus rise">
            <div className="focus-head">
              <div className="focus-time">{fmtClock(running.workedMs)}</div>
              <div className="focus-proj">
                {st && <i className="dt-dot" style={{ background: st.color }} />}
                {runningProject?.name ?? 'Tracking'}
              </div>
            </div>

            <div className="focus-card">
              <DayTimeline entries={entries} now={now} runningEntryId={running.entryId} />
              <Legend />
            </div>

            <div className="focus-actions">
              <div className="round-btn-label">
                <button className="round-btn" disabled title="Pause (coming soon)">
                  <Pause size={24} strokeWidth={2} fill="currentColor" />
                </button>
                <span>Pause</span>
              </div>
              <div className="round-btn-label">
                <button className="round-btn danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
                  <Square size={22} strokeWidth={2} fill="currentColor" />
                </button>
                <span>Stop</span>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Today</span>
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          <div className="hero-running rise rise-1">
            <div>
              <div className="hero-time">{fmtClock(0)}</div>
              <div className="hero-proj"><Clock size={14} /> No timer running</div>
            </div>
          </div>

          {entries.length > 0 && (
            <>
              <div className="section-head"><span className="section-title">Today&rsquo;s activity</span></div>
              <div className="focus-card rise rise-2">
                <DayTimeline entries={entries} now={now} />
                <Legend />
              </div>
            </>
          )}

          <div className="section-head"><span className="section-title">Projects</span></div>
          {projects.isLoading && <div className="callout secondary" style={{ padding: '0 4px' }}>Loading…</div>}
          <div className="task-list">
            {projects.data?.map((p, i) => {
              const st = projectStyle(p.id);
              const Icon = st.icon;
              return (
                <button
                  key={p.id}
                  className={`task rise rise-${Math.min(i + 1, 3)}`}
                  onClick={() => start.mutate(p.id)}
                  disabled={start.isPending}
                >
                  <span className="task-icon" style={{ background: st.color }}>
                    <Icon size={20} strokeWidth={2} />
                  </span>
                  <span className="task-main">
                    <span className="task-title" style={{ display: 'block' }}>{p.name}</span>
                    <span className="task-tags">
                      <span className="tag" style={{ background: st.tagBg, color: st.tagFg }}>Project</span>
                    </span>
                  </span>
                  <span className="task-play"><Play size={15} strokeWidth={2.5} fill="currentColor" /></span>
                </button>
              );
            })}
          </div>

          <ScreenshotsStrip />
        </div>
      </div>
    </>
  );
}

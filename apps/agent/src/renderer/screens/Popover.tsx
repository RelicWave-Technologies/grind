import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play, Square, ExternalLink, Timer } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { fmtClock } from './Today';

/** Compact menu-bar popover: current status + quick start/stop + open app. */
export default function Popover() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => window.agent.projects.list() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE' });

  useEffect(() => {
    void window.agent.timer.status().then(setTimer);
    return window.agent.timer.onStatusChange(setTimer);
  }, []);

  const start = useMutation({ mutationFn: (id: string) => window.agent.timer.start(id), onSuccess: setTimer });
  const stop = useMutation({ mutationFn: () => window.agent.timer.stop(), onSuccess: setTimer });

  const running = timer.state === 'RUNNING' ? timer : null;
  const runningProject = running ? projects.data?.find((p) => p.id === running.projectId) : undefined;
  const st = runningProject ? projectStyle(runningProject.id) : null;

  return (
    <div className="pop">
      <div className="pop-head">
        <span className="brand-mark" style={{ width: 22, height: 22 }}><Timer size={13} strokeWidth={2.5} /></span>
        <span className="brand-name" style={{ fontSize: 14 }}>Grind</span>
        <button className="pop-open no-drag" title="Open Grind" onClick={() => window.agent.window.openMain()}>
          <ExternalLink size={15} strokeWidth={2} />
        </button>
      </div>

      {running ? (
        <div className="pop-running">
          <div className="pop-time tabular">{fmtClock(running.workedMs)}</div>
          <div className="pop-proj">
            {st && <i className="dt-dot" style={{ background: st.color }} />}
            {runningProject?.name ?? 'Tracking'}
          </div>
          <button className="btn btn-danger btn-block no-drag" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={13} strokeWidth={2.5} fill="currentColor" /> Stop
          </button>
        </div>
      ) : (
        <div className="pop-list no-drag">
          <div className="small tertiary" style={{ padding: '0 2px 6px' }}>START TRACKING</div>
          {projects.data?.slice(0, 4).map((p) => {
            const ps = projectStyle(p.id);
            const Icon = ps.icon;
            return (
              <button key={p.id} className="pop-row" onClick={() => start.mutate(p.id)} disabled={start.isPending}>
                <span className="pop-icon" style={{ background: ps.color }}><Icon size={15} strokeWidth={2} /></span>
                <span className="pop-row-name">{p.name}</span>
                <Play size={13} strokeWidth={2.5} fill="var(--violet)" color="var(--violet)" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

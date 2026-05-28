import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { fmtClock } from './Today';

/** Always-on-top mini bar shown while tracking. */
export default function FloatingBar() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => window.agent.projects.list() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE' });

  useEffect(() => {
    void window.agent.timer.status().then(setTimer);
    return window.agent.timer.onStatusChange(setTimer);
  }, []);

  if (timer.state !== 'RUNNING') return <div className="fbar" />;
  const project = projects.data?.find((p) => p.id === timer.projectId);
  const st = project ? projectStyle(project.id) : null;

  return (
    <div className="fbar" onDoubleClick={() => window.agent.window.openMain()}>
      <span className="fbar-dot" style={{ background: st?.color ?? 'var(--violet)' }} />
      <span className="fbar-time tabular">{fmtClock(timer.workedMs)}</span>
      <span className="fbar-proj">{project?.name ?? 'Tracking'}</span>
      <button className="fbar-stop no-drag" title="Stop" onClick={() => window.agent.timer.stop()}>
        <Square size={13} strokeWidth={2.5} fill="currentColor" />
      </button>
    </div>
  );
}

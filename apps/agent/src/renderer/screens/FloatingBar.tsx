import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Square, GripVertical } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { fmtClock } from './Today';

/** Always-on-top mini bar shown while tracking. */
export default function FloatingBar() {
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });

  useEffect(() => {
    void window.agent.timer.status().then(setTimer);
    return window.agent.timer.onStatusChange(setTimer);
  }, []);

  if (timer.state !== 'RUNNING') return <div className="fbar" />;
  const task = timer.larkTaskGuid ? larkTasks.data?.tasks.find((t) => t.guid === timer.larkTaskGuid) : undefined;
  const st = timer.larkTaskGuid ? projectStyle(timer.larkTaskGuid) : null;
  const resume = () => {
    void window.agent.timer.resume().then(setTimer);
  };
  const stop = () => {
    void window.agent.timer.stop().then(setTimer);
  };

  // The grip is the drag region; the rest is clickable (double-click opens app).
  return (
    <div className="fbar">
      <span className="fbar-grip" title="Drag to move"><GripVertical size={14} strokeWidth={2} /></span>
      <button
        className="fbar-body no-drag"
        title="Open Grind"
        onClick={() => window.agent.window.openMain()}
      >
        <span className="fbar-dot" style={{ background: st?.color ?? 'var(--violet)' }} />
        <span className="fbar-time tabular">{fmtClock(timer.workedMs)}</span>
        <span className="fbar-proj">{task?.summary ?? 'Tracking'}{timer.paused ? ' · paused' : ''}</span>
      </button>
      {timer.paused && (
        <button className="fbar-resume no-drag" title="Resume" onClick={resume}>
          <Play size={13} strokeWidth={2.5} fill="currentColor" />
        </button>
      )}
      <button className="fbar-stop no-drag" title="Stop" onClick={stop}>
        <Square size={13} strokeWidth={2.5} fill="currentColor" />
      </button>
    </div>
  );
}

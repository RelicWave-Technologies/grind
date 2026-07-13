import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, GripVertical, X } from 'lucide-react';
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
  const togglePaused = async () => {
    if (timer.paused) {
      const result = await window.agent.timer.resume();
      setTimer(result.status);
      return;
    }
    setTimer(await window.agent.timer.pause());
  };
  const dismiss = () => void window.agent.window.dismissFloatingBar();

  // The grip is the drag region; the remaining controls are normal buttons.
  return (
    <div className="fbar">
      <span className="fbar-grip" title="Drag to move"><GripVertical size={14} strokeWidth={2} /></span>
      <button
        className="fbar-body no-drag"
        title="Open Timo"
        onClick={() => window.agent.window.openMain()}
      >
        <span className="fbar-dot" style={{ background: st?.color ?? 'var(--violet)' }} />
        <span className="fbar-time tabular">{fmtClock(timer.workedMs)}</span>
        <span className="fbar-proj">{task?.summary ?? 'Tracking'}{timer.paused ? ' · paused' : ''}</span>
      </button>
      <button
        className={`fbar-toggle no-drag${timer.paused ? ' is-resume' : ''}`}
        title={timer.paused ? 'Resume tracking' : 'Pause tracking'}
        aria-label={timer.paused ? 'Resume tracking' : 'Pause tracking'}
        onClick={() => void togglePaused()}
      >
        {timer.paused ? (
          <Play size={13} strokeWidth={2.5} fill="currentColor" />
        ) : (
          <Pause size={13} strokeWidth={2.5} fill="currentColor" />
        )}
      </button>
      <button className="fbar-close no-drag" title="Close floating bar" aria-label="Close floating bar" onClick={dismiss}>
        <X size={14} strokeWidth={2.25} />
      </button>
    </div>
  );
}

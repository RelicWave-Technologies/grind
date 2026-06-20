import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play, Square, ExternalLink, ListTodo } from 'lucide-react';
import grindIcon from '../assets/grind-icon.svg';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { fmtClock } from './Today';

/** Compact menu-bar popover: current status + quick start/stop + open app. */
export default function Popover() {
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });

  useEffect(() => {
    void window.agent.timer.status().then(setTimer);
    return window.agent.timer.onStatusChange(setTimer);
  }, []);

  const start = useMutation({ mutationFn: (guid: string) => window.agent.timer.start(guid), onSuccess: setTimer });
  const stop = useMutation({ mutationFn: () => window.agent.timer.stop(), onSuccess: setTimer });

  const tasks = larkTasks.data?.tasks ?? [];
  const openTasks = tasks.filter((t) => !t.completed);
  const running = timer.state === 'RUNNING' ? timer : null;
  const runningTask = running?.larkTaskGuid ? tasks.find((t) => t.guid === running.larkTaskGuid) : undefined;
  const st = running?.larkTaskGuid ? projectStyle(running.larkTaskGuid) : null;

  return (
    <div className="pop">
      <div className="pop-head">
        <span className="brand-mark" style={{ width: 22, height: 22 }}><img src={grindIcon} alt="" /></span>
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
            {runningTask?.summary ?? 'Tracking'}
          </div>
          <button className="btn btn-danger btn-block no-drag" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={13} strokeWidth={2.5} fill="currentColor" /> Stop
          </button>
        </div>
      ) : (
        <div className="pop-list no-drag">
          <div className="pop-today-total">
            <span>Today tracked</span>
            <strong className="tabular">{fmtClock(timer.workedMs)}</strong>
          </div>
          <div className="small tertiary" style={{ padding: '0 2px 6px' }}>START TRACKING</div>
          {openTasks.length === 0 ? (
            <div className="callout secondary" style={{ padding: '2px' }}>
              {larkTasks.data && larkTasks.data.tasks.length === 0 ? 'No Lark tasks' : 'Open Grind to connect Lark'}
            </div>
          ) : (
            openTasks.slice(0, 5).map((t) => {
              const ps = projectStyle(t.guid);
              return (
                <button key={t.guid} className="pop-row" onClick={() => start.mutate(t.guid)} disabled={start.isPending}>
                  <span className="pop-icon" style={{ background: ps.color }}><ListTodo size={15} strokeWidth={2} /></span>
                  <span className="pop-row-name">{t.summary}</span>
                  <Play size={13} strokeWidth={2.5} fill="var(--violet)" color="var(--violet)" />
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

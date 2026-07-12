import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play, Square, ExternalLink, ListTodo, Search } from 'lucide-react';
import timoMascot from '../assets/timo-mascot.svg';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { sortTasks } from '../lib/taskFormat';
import { fmtClock } from './Today';

function trackedTaskGuid(status: TimerStatus): string | null {
  return status.state === 'RUNNING' ? status.larkTaskGuid : null;
}

/** Compact menu-bar popover: current status + quick start/stop + open app. */
export default function Popover() {
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });
  const [selectedTaskGuid, setSelectedTaskGuid] = useState('');
  const [taskQuery, setTaskQuery] = useState('');

  useEffect(() => {
    let alive = true;
    const rememberRunningTask = (status: TimerStatus) => {
      const guid = trackedTaskGuid(status);
      if (guid) setSelectedTaskGuid(guid);
    };
    void window.agent.timer.status().then((status) => {
      if (!alive) return;
      setTimer(status);
      rememberRunningTask(status);
    });
    const off = window.agent.timer.onStatusChange((status) => {
      setTimer(status);
      rememberRunningTask(status);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useMutation({
    mutationFn: (guid: string) => window.agent.timer.start(guid),
    onSuccess: (result) => {
      const status = result.status;
      setTimer(status);
      setTaskQuery('');
      const guid = trackedTaskGuid(status);
      if (guid) setSelectedTaskGuid(guid);
    },
  });
  const stop = useMutation({ mutationFn: () => window.agent.timer.stop(), onSuccess: setTimer });
  const resume = useMutation({ mutationFn: () => window.agent.timer.resume(), onSuccess: (result) => setTimer(result.status) });

  const tasks = larkTasks.data?.tasks ?? [];
  const running = timer.state === 'RUNNING' ? timer : null;
  const runningTask = running?.larkTaskGuid ? tasks.find((t) => t.guid === running.larkTaskGuid) : undefined;
  const st = running?.larkTaskGuid ? projectStyle(running.larkTaskGuid) : null;
  const openTasks = useMemo(
    () => sortTasks(tasks.filter((task) => !task.completed), (running?.larkTaskGuid ?? selectedTaskGuid) || null),
    [running?.larkTaskGuid, selectedTaskGuid, tasks],
  );
  const visibleTasks = useMemo(() => {
    const query = taskQuery.trim().toLowerCase();
    if (!query) return openTasks;
    return openTasks.filter((task) => task.summary.toLowerCase().includes(query));
  }, [openTasks, taskQuery]);

  return (
    <div className="pop">
      <div className="pop-head">
        <span className="brand-mark" style={{ width: 32, height: 32 }}><img src={timoMascot} alt="" /></span>
        <span className="brand-name" style={{ fontSize: 14 }}>Timo</span>
        <button className="pop-open no-drag" title="Open Timo" onClick={() => window.agent.window.openMain()}>
          <ExternalLink size={15} strokeWidth={2} />
        </button>
      </div>

      {running ? (
        <div className="pop-running">
          <div className="pop-time tabular">{fmtClock(running.workedMs)}</div>
          <div className="pop-proj">
            {st && <i className="dt-dot" style={{ background: st.color }} />}
            {runningTask?.summary ?? 'Tracking'}{running.paused ? ' · paused' : ''}
          </div>
          <div className="pop-actions">
            {running.paused && (
              <button className="btn btn-prominent btn-block no-drag" onClick={() => resume.mutate()} disabled={resume.isPending}>
                <Play size={13} strokeWidth={2.5} fill="currentColor" /> Resume
              </button>
            )}
            <button className="btn btn-danger btn-block no-drag" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square size={13} strokeWidth={2.5} fill="currentColor" /> Stop
            </button>
          </div>
        </div>
      ) : (
        <div className="pop-list no-drag">
          <div className="pop-today-total">
            <span>Today tracked</span>
            <strong className="tabular">{fmtClock(timer.workedMs)}</strong>
          </div>
          {openTasks.length === 0 ? (
            <div className="callout secondary" style={{ padding: '2px' }}>
              {larkTasks.data && larkTasks.data.tasks.length === 0 ? 'No Lark tasks' : 'Open Timo to connect Lark'}
            </div>
          ) : (
            <div className="pop-task-list-wrap">
              <div className="pop-task-search no-drag">
                <Search size={14} strokeWidth={2.2} />
                <input
                  value={taskQuery}
                  onChange={(event) => setTaskQuery(event.target.value)}
                  placeholder={`Search ${openTasks.length} tasks`}
                />
              </div>
              <div className="pop-task-list" role="list" aria-label="Open tasks">
                {visibleTasks.length === 0 ? (
                  <div className="pop-task-empty">No matching tasks</div>
                ) : (
                  visibleTasks.map((task) => {
                    const ps = projectStyle(task.guid);
                    const selected = task.guid === selectedTaskGuid;
                    return (
                      <div className={`pop-task-row${selected ? ' selected' : ''}`} role="listitem" key={task.guid}>
                        <span className="pop-task-icon" style={{ background: ps.color }}>
                          <ListTodo size={12} strokeWidth={2.2} />
                        </span>
                        <span className="pop-task-name" title={task.summary}>{task.summary}</span>
                        <button
                          type="button"
                          className="pop-start-btn no-drag"
                          onClick={() => {
                            setSelectedTaskGuid(task.guid);
                            start.mutate(task.guid);
                          }}
                          disabled={start.isPending}
                          title={`Start ${task.summary}`}
                          aria-label={`Start ${task.summary}`}
                        >
                          <Play size={12} strokeWidth={2.5} fill="currentColor" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

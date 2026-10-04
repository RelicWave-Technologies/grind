import { Play, Square, Clock, CalendarClock } from 'lucide-react';
import TaskOwner from './TaskOwner';
import { dueInfo, fmtDate, fmtDuration, type LarkTaskItem } from '../lib/taskFormat';
import { taskTimerAction, taskTimerLabel, taskTimerState } from '../lib/timerUi';

/**
 * A single Lark task row. Click to start tracking (or stop, if it's the one
 * running). Shows who it came from, creator + created date, and due / time-logged
 * chips. Presentational — all state lives in the parent.
 */
export default function TaskCard({
  task,
  now,
  timeZone,
  running,
  paused,
  disabled,
  onStart,
  onStop,
  onResume,
}: {
  task: LarkTaskItem;
  now: number;
  timeZone: string | null;
  running: boolean;
  paused?: boolean;
  disabled?: boolean;
  onStart: (guid: string) => void;
  onStop: () => void;
  onResume?: () => void;
}) {
  const due = task.due != null && timeZone ? dueInfo(task.due, now, timeZone) : null;
  const timerState = taskTimerState({ running, paused });
  const timerAction = taskTimerAction(timerState);
  const timerLabel = taskTimerLabel(timerState);
  const loggedTodayMs = task.loggedTodayMs ?? task.loggedMs;

  return (
    <button
      className={`task${running ? ' task-running' : ''}`}
      onClick={() => {
        if (timerAction === 'stop') onStop();
        else if (timerAction === 'resume' && onResume) onResume();
        else onStart(task.guid);
      }}
      disabled={disabled}
    >
      <TaskOwner task={task} size={36} />
      <span className="task-main">
        <span className="task-title" style={{ display: 'block' }}>{task.summary}</span>
        {(task.creatorName || task.createdAt) && (
          <span className="task-meta">
            {[task.creatorName ? `By ${task.creatorName}` : null, task.createdAt ? fmtDate(task.createdAt, timeZone) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <span className="task-tags">
          {timerLabel && (
            <span className={`tag tag-chip ${timerState === 'paused' ? 'tag-paused' : 'tag-live'}`}>
              <span className={timerState === 'paused' ? 'pause-dot' : 'live-dot'} /> {timerLabel}
            </span>
          )}
          {due && (
            <span className={`tag tag-chip due-${due.tone}`}>
              <CalendarClock size={11} strokeWidth={2.5} /> {due.label}
            </span>
          )}
          {loggedTodayMs > 0 && (
            <span className="tag tag-chip tag-logged">
              <Clock size={11} strokeWidth={2.5} /> Today {fmtDuration(loggedTodayMs)}
            </span>
          )}
        </span>
      </span>
      <span className={`task-play${timerAction === 'stop' ? ' stop' : ''}${timerAction === 'resume' ? ' resume' : ''}`}>
        {timerAction === 'stop' ? <Square size={13} strokeWidth={2.5} fill="currentColor" /> : <Play size={15} strokeWidth={2.5} fill="currentColor" />}
      </span>
    </button>
  );
}

import { Play, Square, ListTodo, Clock, CalendarClock, User } from 'lucide-react';
import { projectStyle } from '../lib/projectStyle';
import { dueInfo, fmtDate, fmtDuration, type LarkTaskItem } from '../lib/taskFormat';
import { taskTimerAction, taskTimerLabel, taskTimerState } from '../lib/timerUi';

/**
 * A single Lark task row. Click to start tracking (or stop, if it's the one
 * running). Shows per-task color, creator + created date, and due / time-logged
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
  const st = projectStyle(task.guid);
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
      <span className="task-icon" style={{ background: st.color }}>
        <ListTodo size={20} strokeWidth={2} />
      </span>
      <span className="task-main">
        <span className="task-title" style={{ display: 'block' }}>{task.summary}</span>
        {(task.creatorName || task.createdAt) && (
          <span className="task-meta">
            <User size={11} strokeWidth={2} />
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
            <span className="tag tag-chip" style={{ background: 'var(--violet-tint)', color: 'var(--violet-700)' }}>
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

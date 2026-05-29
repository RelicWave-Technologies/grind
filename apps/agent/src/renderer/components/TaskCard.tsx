import { Play, Square, ListTodo, Clock, CalendarClock, User } from 'lucide-react';
import { projectStyle } from '../lib/projectStyle';
import { dueInfo, fmtDate, fmtDuration, type LarkTaskItem } from '../lib/taskFormat';

/**
 * A single Lark task row. Click to start tracking (or stop, if it's the one
 * running). Shows per-task color, creator + created date, and due / time-logged
 * chips. Presentational — all state lives in the parent.
 */
export default function TaskCard({
  task,
  now,
  running,
  disabled,
  onStart,
  onStop,
}: {
  task: LarkTaskItem;
  now: number;
  running: boolean;
  disabled?: boolean;
  onStart: (guid: string) => void;
  onStop: () => void;
}) {
  const st = projectStyle(task.guid);
  const due = task.due != null ? dueInfo(task.due, now) : null;

  return (
    <button
      className={`task${running ? ' task-running' : ''}`}
      onClick={() => (running ? onStop() : onStart(task.guid))}
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
            {[task.creatorName ? `By ${task.creatorName}` : null, task.createdAt ? fmtDate(task.createdAt) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <span className="task-tags">
          {running && <span className="tag tag-chip tag-live"><span className="live-dot" /> Tracking</span>}
          {due && (
            <span className={`tag tag-chip due-${due.tone}`}>
              <CalendarClock size={11} strokeWidth={2.5} /> {due.label}
            </span>
          )}
          {task.loggedMs > 0 && (
            <span className="tag tag-chip" style={{ background: 'var(--violet-tint)', color: 'var(--violet-700)' }}>
              <Clock size={11} strokeWidth={2.5} /> {fmtDuration(task.loggedMs)}
            </span>
          )}
        </span>
      </span>
      <span className={`task-play${running ? ' stop' : ''}`}>
        {running ? <Square size={13} strokeWidth={2.5} fill="currentColor" /> : <Play size={15} strokeWidth={2.5} fill="currentColor" />}
      </span>
    </button>
  );
}

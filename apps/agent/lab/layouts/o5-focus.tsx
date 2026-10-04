/**
 * Option 5 — Focus. One calm screen that changes with what you are doing:
 * a big timer while you track, "What are you working on?" when you are not.
 * The day ribbon is the floor of the window. Tasks, your day and settings
 * slide in only when asked.
 */
import { useState } from 'react';
import { ArrowLeftRight, CalendarDays, ChevronDown, ListTodo, Play, Search, Settings as Gear } from 'lucide-react';
import { AccountMenu, DueChip, EntryLog, HourBars, Lights, LiveDot, Ribbon, Sheet, SettingsBody, ShotGrid, TaskMark, TaskPicker, Transport, Window, useStatus } from './kit';
import { OPEN_TASKS, STATS, fmtClock, fmtDur, groupByDue, sortedOpen, useDay, type Task } from './model';
import './o5-focus.css';

type Panel = 'none' | 'tasks' | 'day' | 'settings';

export default function OptionFocus() {
  const day = useDay();
  const [panel, setPanel] = useState<Panel>('none');
  const close = () => setPanel('none');

  return (
    <Window width={960} height={640} className={`o5 o5--${day.mode}`}>
      <div className="o5-rings" aria-hidden="true" />
      <Lights />
      <div className="o5-corner">
        <button className={`lx-btn lx-btn--sm lx-btn--ghost${panel === 'tasks' ? ' on' : ''}`} onClick={() => setPanel('tasks')}><ListTodo size={15} /> Tasks</button>
        <button className={`lx-btn lx-btn--sm lx-btn--ghost${panel === 'day' ? ' on' : ''}`} onClick={() => setPanel('day')}><CalendarDays size={15} /> My day</button>
        <button className="lx-icon-btn" title="Settings" onClick={() => setPanel('settings')}><Gear size={17} /></button>
        <AccountMenu size={28} />
      </div>

      <main className="o5-stage">{day.mode === 'idle' ? <Pick onAll={() => setPanel('tasks')} /> : <Tracking onSwitch={() => setPanel('tasks')} />}</main>

      <footer className="o5-floor">
        <div className="o5-floor-line">
          <span>Today <b className="lx-num">{fmtDur(day.trackedMin)}</b></span>
          <span className="o5-floor-aside">{STATS.score} productivity · {STATS.screenshots} screenshots, last one a minute ago</span>
        </div>
        <Ribbon from={8 * 60} to={19 * 60} height={26} />
      </footer>

      <Sheet open={panel === 'tasks'} onClose={close} side="bottom" title="Tasks">
        <AllTasks onPicked={close} />
      </Sheet>
      <Sheet open={panel === 'day'} onClose={close} side="right" title="My day">
        <MyDay />
      </Sheet>
      <Sheet open={panel === 'settings'} onClose={close} title="Settings">
        <SettingsBody />
      </Sheet>
    </Window>
  );
}

function Tracking({ onSwitch }: { onSwitch: () => void }) {
  const day = useDay();
  const status = useStatus();
  return (
    <div className="o5-center">
      <span className="o5-status">
        <LiveDot paused={day.mode === 'paused'} />
        {day.mode === 'paused' ? 'Paused' : 'Tracking'}
        <i className="o5-status-sep">·</i>
        {status.text.replace(/^(Tracking|Paused) /, '')}
      </span>
      <TaskPicker align="center" width={440}>
        <span className="o5-task">{day.task.summary}</span>
        <ChevronDown size={16} className="o5-caret" />
      </TaskPicker>
      <Clock ms={day.timerMs} />
      <div className="o5-actions">
        <Transport labels />
        <button className="lx-btn lx-btn--lg lx-btn--ghost o5-switch" onClick={onSwitch}><ArrowLeftRight size={16} /> Switch task</button>
      </div>
    </div>
  );
}

/** Each digit gets a fixed cell so the clock never jitters. Hours and minutes in ink, seconds in Azure: the part that moves is the part that means "tracking". */
function Clock({ ms }: { ms: number }) {
  const text = fmtClock(ms);
  const secondsFrom = text.lastIndexOf(':') + 1;
  return (
    <span className="o5-clock" aria-label={text}>
      {text.split('').map((ch, i) =>
        ch === ':' ? (
          <span key={i} className="o5-colon">:</span>
        ) : (
          <span key={i} className={`o5-digit${i >= secondsFrom ? ' o5-sec' : ''}`}>{ch}</span>
        ),
      )}
    </span>
  );
}

function Pick({ onAll }: { onAll: () => void }) {
  const day = useDay();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const tasks = sortedOpen(day.task.guid).filter((t) => q === '' || t.summary.toLowerCase().includes(q));
  return (
    <div className="o5-center o5-pick">
      <span className="o5-status o5-status--off">Not tracking</span>
      <h2>What are you working on?</h2>
      <label className="lx-search o5-find">
        <Search size={16} />
        <input placeholder={`Search ${OPEN_TASKS.length} tasks`} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="o5-tiles">
        {tasks.slice(0, 4).map((t) => (
          <Tile key={t.guid} task={t} last={t.guid === day.task.guid} />
        ))}
      </div>
      <button className="lx-btn lx-btn--sm lx-btn--ghost" onClick={onAll}>All {OPEN_TASKS.length} tasks</button>
    </div>
  );
}

function Tile({ task, last }: { task: Task; last: boolean }) {
  const day = useDay();
  return (
    <button className="o5-tile" onClick={() => day.start(task.guid)}>
      <TaskMark task={task} size={30} />
      <span className="o5-tile-main">
        <span className="o5-tile-name">{task.summary}</span>
        <span className="o5-tile-meta">
          {last ? <span className="o5-tile-last">Last tracked</span> : <DueChip task={task} quiet />}
        </span>
      </span>
      <span className="o5-tile-play"><Play size={13} fill="currentColor" strokeWidth={0} /></span>
    </button>
  );
}

function AllTasks({ onPicked }: { onPicked: () => void }) {
  const day = useDay();
  return (
    <div className="o5-all">
      <div className="o5-all-search">
        <label className="lx-search"><Search size={14} /><input placeholder="Search tasks" /></label>
      </div>
      {groupByDue(sortedOpen(day.task.guid)).map((g) => (
        <section key={g.label}>
          <h4>{g.label}</h4>
          {g.tasks.map((t) => {
            const current = t.guid === day.task.guid && day.mode !== 'idle';
            return (
              <button
                key={t.guid}
                className={`o5-all-row${current ? ' on' : ''}`}
                onClick={() => {
                  if (!current) day.start(t.guid);
                  onPicked();
                }}
              >
                <TaskMark task={t} size={26} />
                <span className="o5-all-name">{t.summary}</span>
                {current ? <span className="o5-all-now"><LiveDot paused={day.mode === 'paused'} /> Now</span> : <DueChip task={t} />}
                <span className="o5-all-time lx-num">{day.loggedTodayMin(t.guid) > 0 ? fmtDur(day.loggedTodayMin(t.guid)) : ''}</span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function MyDay() {
  const day = useDay();
  return (
    <div className="o5-day">
      <div className="o5-figs">
        <span><b className="lx-num">{fmtDur(day.trackedMin)}</b>Tracked</span>
        <span><b className="lx-num">{STATS.score}</b>Productivity</span>
        <span><b className="lx-num">{STATS.keystrokes.toLocaleString()}</b>Keystrokes</span>
        <span><b className="lx-num">{STATS.clicks.toLocaleString()}</b>Clicks</span>
      </div>
      <h4>Activity by hour</h4>
      <HourBars from={8} to={19} height={56} labels />
      <h4>Time log</h4>
      <EntryLog />
      <h4>Latest screenshots</h4>
      <ShotGrid count={6} columns={3} />
    </div>
  );
}

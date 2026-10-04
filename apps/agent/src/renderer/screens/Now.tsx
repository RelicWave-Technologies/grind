import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Check, ChevronDown, Pause, Play, Search, Square } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import TaskOwner from '../components/TaskOwner';
import { dueInfo, fmtDuration, sortTasks, type LarkTaskItem } from '../lib/taskFormat';
import larkIcon from '../assets/lark.svg';
import DayTimeline from '../components/DayTimeline';
import { useIntroHold } from '../components/AppIntro';
import { fmtClock } from '../lib/timerUi';
import { useWorkspaceTime, workspaceTimeReady } from '../lib/workspaceTime';

/** Hours and minutes in ink, the seconds in Azure: the part that moves is the part that means tracking. */
function TimerClock({ ms }: { ms: number }) {
  const text = fmtClock(ms);
  const secondsFrom = text.lastIndexOf(':') + 1;
  return (
    <span className="focus-clock" aria-label={text}>
      {text.split('').map((ch, i) =>
        ch === ':' ? (
          <span key={i} className="focus-colon">:</span>
        ) : (
          <span key={i} className={`focus-digit${i >= secondsFrom ? ' focus-sec' : ''}`}>{ch}</span>
        ),
      )}
    </span>
  );
}

function clockTime(ms: number, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timeZone ?? undefined }).format(ms);
}

/**
 * The main window's one screen (DESIGN.md §5 The desktop window, Focus): a
 * big timer while you track, "What are you working on?" when you don't, and
 * the day's ribbon along the floor. The task list, your day and settings are
 * sheets the shell opens; `onOpenTasks` asks for the task list.
 */
export default function Now({ onOpenTasks }: { onOpenTasks: () => void }) {
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => window.agent.timer.today(), refetchInterval: 3000 });
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks(), refetchInterval: 60_000 });
  const insights = useQuery({ queryKey: ['insightsToday'], queryFn: () => window.agent.insights.today(), refetchInterval: 15_000 });
  const workspaceTime = useWorkspaceTime();
  const timeContext = workspaceTime.data;
  const hasWorkspaceTime = workspaceTimeReady(timeContext);
  const timeZone = hasWorkspaceTime ? timeContext.timeZone : null;
  const todayShift = useQuery({
    queryKey: ['todayShift', timeContext?.date],
    queryFn: () => window.agent.shift.today(),
    enabled: hasWorkspaceTime,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const [timer, setTimer] = useState<TimerStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [selectedTaskGuid, setSelectedTaskGuid] = useState('');

  // The intro waits for the first picture of the day: the timer, the tasks, the entries.
  useIntroHold(timer === null || larkStatus.isLoading || larkTasks.isLoading || today.isLoading);

  useEffect(() => {
    let alive = true;
    const rememberRunningTask = (s: TimerStatus) => {
      if (s.state === 'RUNNING' && s.larkTaskGuid) setSelectedTaskGuid(s.larkTaskGuid);
    };
    void window.agent.timer.status().then((s) => {
      if (!alive) return;
      setTimer(s);
      rememberRunningTask(s);
      // Boot closes any open entry, so status is never RUNNING here and
      // rememberRunningTask can't fire. Fall back to the task last tracked so
      // reopening Timo offers the work the user was actually on.
      if (s.state !== 'RUNNING') {
        void window.agent.timer.lastTaskGuid().then((guid) => {
          if (!alive || !guid) return;
          setSelectedTaskGuid((current) => (current === '' ? guid : current));
        });
      }
    });
    const off = window.agent.timer.onStatusChange((s) => {
      setTimer(s);
      setNow(Date.now());
      rememberRunningTask(s);
      void qc.invalidateQueries({ queryKey: ['timerRecoveryNotice'] });
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(tick);
    };
  }, [qc]);

  const settle = (status: TimerStatus) => {
    setTimer(status);
    void qc.invalidateQueries({ queryKey: ['today'] });
  };
  const start = useMutation({ mutationFn: (guid: string) => window.agent.timer.start(guid), onSuccess: (r) => settle(r.status) });
  const stop = useMutation({ mutationFn: () => window.agent.timer.stop(), onSuccess: settle });
  const pause = useMutation({ mutationFn: () => window.agent.timer.pause(), onSuccess: settle });
  const resume = useMutation({ mutationFn: () => window.agent.timer.resume(), onSuccess: (r) => settle(r.status) });
  const connectLark = useMutation({ mutationFn: () => window.agent.lark.connect() });
  const busy = start.isPending || stop.isPending || pause.isPending || resume.isPending;

  const running = timer?.state === 'RUNNING' ? timer : null;
  const tasks = larkTasks.data?.tasks ?? [];
  const openTasks = sortTasks(
    tasks.filter((t) => !t.completed),
    (running?.larkTaskGuid ?? selectedTaskGuid) || null,
  );
  const runningTask = running?.larkTaskGuid ? tasks.find((t) => t.guid === running.larkTaskGuid) : undefined;
  const larkConnected = !!larkStatus.data?.connected;
  const larkOffline = !!larkStatus.data?.offline;
  const larkConfigured = larkStatus.data?.configured !== false;
  const catalogAvailable = larkConnected || (larkOffline && tasks.length > 0);
  const markedShift = todayShift.data
    ? { startedAt: todayShift.data.startedAt, endedAt: todayShift.data.endedAt, label: `${todayShift.data.name} · ${todayShift.data.start}–${todayShift.data.end}` }
    : null;
  const trackedMinutes = insights.data?.score.trackedMinutes ?? 0;

  return (
    <div className={`focus${running?.paused ? ' focus--paused' : ''}`}>
      <main className="focus-stage">
        {running ? (
          <div className="focus-center">
            <span className="focus-status">
              <i className={running.paused ? 'pause-dot' : 'live-dot live-dot--brand'} />
              {running.paused ? 'Paused' : 'Tracking'}
              <i className="focus-status-sep">·</i>
              since {clockTime(running.startedAt, timeZone)}
            </span>
            <TaskPicker
              tasks={openTasks}
              currentGuid={running.larkTaskGuid}
              disabled={busy || !catalogAvailable}
              onPick={(guid) => guid !== running.larkTaskGuid && start.mutate(guid)}
            >
              <span className="focus-task">{runningTask?.summary ?? 'Tracking'}</span>
            </TaskPicker>
            <TimerClock ms={timer?.workedMs ?? 0} />
            <div className="focus-actions">
              {running.paused ? (
                <button className="btn btn-prominent btn-lg no-drag" onClick={() => resume.mutate()} disabled={busy}>
                  <Play size={16} fill="currentColor" strokeWidth={0} /> Resume
                </button>
              ) : (
                <button className="btn btn-lg focus-pause no-drag" onClick={() => pause.mutate()} disabled={busy}>
                  <Pause size={16} fill="currentColor" strokeWidth={0} /> Pause
                </button>
              )}
              <button className="btn btn-ink btn-lg no-drag" onClick={() => stop.mutate()} disabled={busy}>
                <Square size={14} fill="currentColor" strokeWidth={0} /> Stop
              </button>
              {catalogAvailable && (
                <button className="btn btn-ghost btn-lg no-drag" onClick={onOpenTasks}>
                  <ArrowLeftRight size={16} strokeWidth={2} /> Switch task
                </button>
              )}
            </div>
          </div>
        ) : (
          <Pick
            tasks={openTasks}
            lastGuid={selectedTaskGuid}
            now={now}
            timeZone={timeZone}
            loading={larkTasks.isLoading}
            catalogAvailable={catalogAvailable}
            larkOffline={larkOffline}
            larkConfigured={larkConfigured}
            connecting={connectLark.isPending}
            onConnect={() => connectLark.mutate()}
            disabled={busy}
            onStart={(guid) => start.mutate(guid)}
            onAll={onOpenTasks}
          />
        )}
      </main>

      <footer className="focus-floor">
        <div className="focus-floor-line">
          <span>
            Today <b className="tabular">{fmtDuration(trackedMinutes * 60_000)}</b>
          </span>
          {insights.data && trackedMinutes > 0 && <span className="focus-floor-aside">{insights.data.score.score} productivity</span>}
        </div>
        {hasWorkspaceTime && (
          <DayTimeline
            entries={today.data ?? []}
            now={now}
            runningEntryId={running?.entryId}
            dayStart={timeContext.dayStart}
            dayEnd={timeContext.dayEnd}
            timeZone={timeContext.timeZone}
            markedWindow={markedShift}
          />
        )}
      </footer>
    </div>
  );
}

/** Not tracking: the question, a search, and the four tasks most likely next. */
function Pick({
  tasks,
  lastGuid,
  now,
  timeZone,
  loading,
  catalogAvailable,
  larkOffline,
  larkConfigured,
  connecting,
  onConnect,
  disabled,
  onStart,
  onAll,
}: {
  tasks: LarkTaskItem[];
  lastGuid: string;
  now: number;
  timeZone: string | null;
  loading: boolean;
  catalogAvailable: boolean;
  larkOffline: boolean;
  larkConfigured: boolean;
  connecting: boolean;
  onConnect: () => void;
  disabled: boolean;
  onStart: (guid: string) => void;
  onAll: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // The task you last tracked, ready to go again with one press. Only while it
  // is still open; a finished task is never offered back.
  const ready = lastGuid ? tasks.find((t) => t.guid === lastGuid) : undefined;
  const others = ready ? tasks.filter((t) => t.guid !== ready.guid) : tasks;
  // With the ready card on screen the tiles get one row, so the window still
  // fits at its smallest size.
  const shown = others.filter((t) => q === '' || t.summary.toLowerCase().includes(q)).slice(0, ready && q === '' ? 2 : 4);

  if (!loading && !catalogAvailable) {
    return (
      <div className="focus-center focus-pick">
        <span className="focus-status focus-status--off">Not tracking</span>
        <img className="lark-icon lark-icon--empty" src={larkIcon} alt="" />
        <h2>{larkOffline ? 'Offline with no saved tasks' : larkConfigured ? 'Connect Lark to start' : 'Lark is not set up'}</h2>
        <p className="focus-note">
          {larkOffline
            ? 'Reconnect once to refresh your task list.'
            : larkConfigured
              ? 'Your Lark tasks become the things you track time against.'
              : 'Ask your workspace admin to enable the Lark integration.'}
        </p>
        {larkConfigured && !larkOffline && (
          <button className="btn btn-prominent btn-lg no-drag" onClick={onConnect} disabled={connecting}>
            {connecting ? 'Opening…' : 'Connect Lark'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`focus-center focus-pick${ready ? ' focus-pick--ready' : ''}`}>
      <span className="focus-status focus-status--off">Not tracking</span>
      <h2>What are you working on?</h2>
      {ready && (
        <div className="focus-ready">
          <TaskOwner task={ready} size={36} />
          <span className="focus-tile-main">
            <span className="focus-ready-name">{ready.summary}</span>
            <span className="focus-tile-meta focus-tile-meta--last">Last tracked</span>
          </span>
          <button
            className="btn btn-prominent btn-lg focus-ready-start no-drag"
            onClick={() => onStart(ready.guid)}
            disabled={disabled}
          >
            <Play size={16} fill="currentColor" strokeWidth={0} /> Start
          </button>
        </div>
      )}
      <label className="focus-find no-drag">
        <Search size={16} strokeWidth={2} />
        <input
          placeholder={ready ? 'Or find another task' : tasks.length > 0 ? `Search ${tasks.length} tasks` : 'Search tasks'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || disabled) return;
            if (q === '' && ready) onStart(ready.guid);
            else if (shown[0]) onStart(shown[0].guid);
          }}
        />
      </label>
      {loading ? (
        <div className="focus-tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <span key={i} className="focus-tile focus-tile--ghost" />)}
        </div>
      ) : tasks.length === 0 ? (
        <p className="focus-note">No open tasks. New Lark tasks assigned to you will show up here.</p>
      ) : shown.length === 0 ? (
        q === '' ? null : <p className="focus-note">No tasks match “{query}”.</p>
      ) : (
        <div className="focus-tiles">
          {shown.map((t) => {
            const due = t.due != null && timeZone ? dueInfo(t.due, now, timeZone) : null;
            return (
              <button key={t.guid} className="focus-tile no-drag" onClick={() => onStart(t.guid)} disabled={disabled}>
                <TaskOwner task={t} size={30} />
                <span className="focus-tile-main">
                  <span className="focus-tile-name">{t.summary}</span>
                  <span className={`focus-tile-meta${t.guid === lastGuid ? ' focus-tile-meta--last' : due ? ` focus-tile-meta--${due.tone}` : ''}`}>
                    {t.guid === lastGuid ? 'Last tracked' : due ? due.label : t.creatorName ? `By ${t.creatorName}` : 'Lark task'}
                  </span>
                </span>
                <span className="focus-tile-play"><Play size={12} fill="currentColor" strokeWidth={0} /></span>
              </button>
            );
          })}
        </div>
      )}
      {tasks.length > (ready ? 3 : 4) && (
        <button className="btn btn-ghost no-drag focus-all" onClick={onAll}>All {tasks.length} tasks</button>
      )}
    </div>
  );
}

/** The task name as a button; picking another task switches to it. */
function TaskPicker({
  tasks,
  currentGuid,
  disabled,
  onPick,
  children,
}: {
  tasks: LarkTaskItem[];
  currentGuid: string | null;
  disabled: boolean;
  onPick: (guid: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const q = query.trim().toLowerCase();
  const shown = tasks.filter((t) => q === '' || t.summary.toLowerCase().includes(q));
  return (
    <span className="focus-picker" ref={ref}>
      <button className="focus-picker-trigger no-drag" onClick={() => setOpen((v) => !v)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}>
        {children}
        <ChevronDown size={16} strokeWidth={2} className="focus-caret" />
      </button>
      {open && (
        <div className="hero-task-menu focus-picker-menu no-drag" role="dialog" aria-label="Switch task">
          <div className="hero-task-search">
            <Search size={14} strokeWidth={2.2} />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Switch to…" />
          </div>
          <div className="hero-task-options" role="listbox">
            {shown.length === 0 ? (
              <div className="hero-task-empty">No matching tasks</div>
            ) : (
              shown.map((task) => {
                const selected = task.guid === currentGuid;
                return (
                  <button
                    key={task.guid}
                    type="button"
                    className={`hero-task-option${selected ? ' selected' : ''}`}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onPick(task.guid);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <TaskOwner task={task} size={22} />
                    <span className="hero-task-option-name">{task.summary}</span>
                    {selected && <Check size={14} strokeWidth={2.4} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </span>
  );
}

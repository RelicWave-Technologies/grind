import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Play, Square, Clock, ListTodo, Search, Plus, X, ChevronDown, Check } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { timerRecoveryNoticeText } from '../lib/recoveryNotice';
import { sortTasks } from '../lib/taskFormat';
import larkIcon from '../assets/lark.svg';
import DayTimeline from '../components/DayTimeline';
import TaskCard from '../components/TaskCard';
import TaskComposer from '../components/TaskComposer';
import SyncButton from '../components/SyncButton';
import { formatWorkspaceRecoveryTime, useWorkspaceTime, workspaceTimeReady } from '../lib/workspaceTime';

export function fmtClock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function Legend() {
  return (
    <div className="dt-legend">
      <span><i className="dt-dot dt-dot--work" /> Tracked</span>
      <span><i className="dt-dot dt-dot--meeting" /> Meeting</span>
      <span><i className="dt-dot dt-dot--manual" /> Manual</span>
      <span><i className="dt-dot dt-dot--pending" /> Pending</span>
      <span><i className="dt-dot dt-dot--idle" /> Idle</span>
    </div>
  );
}

const TASK_COLLAPSE = 8;

export default function Today() {
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => window.agent.timer.today(), refetchInterval: 3000 });
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks(), refetchInterval: 60_000 });
  const recoveryNotice = useQuery({ queryKey: ['timerRecoveryNotice'], queryFn: () => window.agent.timer.recoveryNotice() });
  const workspaceTime = useWorkspaceTime();
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [selectedTaskGuid, setSelectedTaskGuid] = useState('');
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [taskPickerQuery, setTaskPickerQuery] = useState('');
  const taskPickerRef = useRef<HTMLDivElement>(null);
  const taskPickerSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const rememberRunningTask = (s: TimerStatus) => {
      if (s.state === 'RUNNING' && s.larkTaskGuid) setSelectedTaskGuid(s.larkTaskGuid);
    };
    void window.agent.timer.status().then((s) => {
      if (!alive) return;
      setTimer(s);
      rememberRunningTask(s);
    });
    const off = window.agent.timer.onStatusChange((s) => {
      setTimer(s);
      setNow(Date.now());
      rememberRunningTask(s);
      void qc.invalidateQueries({ queryKey: ['timerRecoveryNotice'] });
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; off(); clearInterval(tick); };
  }, []);

  useEffect(() => {
    if (!taskPickerOpen) return;
    taskPickerSearchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (taskPickerRef.current?.contains(target)) return;
      setTaskPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskPickerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [taskPickerOpen]);

  const start = useMutation({
    mutationFn: (guid: string) => window.agent.timer.start(guid),
    onSuccess: (result) => {
      setTimer(result.status);
      setTaskPickerOpen(false);
      setTaskPickerQuery('');
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
  const stop = useMutation({
    mutationFn: () => window.agent.timer.stop(),
    onSuccess: (status) => {
      setTimer(status);
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
  const resume = useMutation({
    mutationFn: () => window.agent.timer.resume(),
    onSuccess: (result) => {
      setTimer(result.status);
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
  const dismissRecovery = useMutation({
    mutationFn: () => window.agent.timer.dismissRecoveryNotice(),
    onSuccess: () => qc.setQueryData(['timerRecoveryNotice'], null),
  });
  const connectLark = useMutation({ mutationFn: () => window.agent.lark.connect() });

  const onCreated = (summary: string) => {
    setShowCreate(false);
    setQuery('');
    setShowAll(true);
    setJustCreated(summary);
    void qc.invalidateQueries({ queryKey: ['larkTasks'] });
    window.setTimeout(() => setJustCreated(null), 5000);
  };

  const running = timer.state === 'RUNNING' ? timer : null;
  const entries = today.data ?? [];
  const tasks = larkTasks.data?.tasks ?? [];
  const runningTask = running?.larkTaskGuid ? tasks.find((t) => t.guid === running.larkTaskGuid) : undefined;
  const larkConnected = !!larkStatus.data?.connected;
  const larkOffline = !!larkStatus.data?.offline;
  const larkConfigured = larkStatus.data?.configured !== false;
  const canUseSavedTasks = larkOffline && tasks.length > 0;
  const taskCatalogAvailable = larkConnected || canUseSavedTasks;

  const allOpenTasks = sortTasks(tasks.filter((t) => !t.completed), running?.larkTaskGuid ?? null);
  const q = query.trim().toLowerCase();
  const filtered = tasks.filter((t) => !t.completed && (q === '' || t.summary.toLowerCase().includes(q)));
  const openTasks = sortTasks(filtered, running?.larkTaskGuid ?? null);
  const totalOpen = allOpenTasks.length;
  const collapsed = !showAll && q === '' && openTasks.length > TASK_COLLAPSE;
  const shownTasks = collapsed ? openTasks.slice(0, TASK_COLLAPSE) : openTasks;

  const heroColor = running?.larkTaskGuid ? projectStyle(running.larkTaskGuid).color : 'var(--violet)';
  const isPaused = !!running?.paused;
  const selectedTask = allOpenTasks.find((t) => t.guid === selectedTaskGuid) ?? allOpenTasks[0] ?? null;
  const selectedTaskValue = selectedTask?.guid ?? '';
  const selectedTaskColor = selectedTask ? projectStyle(selectedTask.guid).color : 'var(--violet)';
  const pickerQuery = taskPickerQuery.trim().toLowerCase();
  const pickerTasks = pickerQuery === '' ? allOpenTasks : allOpenTasks.filter((task) => task.summary.toLowerCase().includes(pickerQuery));
  const canStartSelectedTask = !!selectedTask && !start.isPending;
  const timeContext = workspaceTime.data;
  const hasWorkspaceTime = workspaceTimeReady(timeContext);

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Today</span>
        {larkConnected && <SyncButton />}
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          {!hasWorkspaceTime && (
            <div className="recovery-banner rise rise-1" role="status">
              <Clock size={16} strokeWidth={2.2} />
              <span>Syncing workspace time...</span>
            </div>
          )}
          {/* Hero = live timer + stop control (no separate page) */}
          <div className={`hero-running rise rise-1${running ? ' on' : ''}`}>
            <div className="hero-copy">
              <div className="hero-time tabular">{fmtClock(timer.workedMs)}</div>
              <div className="hero-proj">
                {running ? (
                  <>
                    <i className="dt-dot" style={{ background: heroColor }} />
                    <span className="hero-proj-name" title={runningTask?.summary ?? 'Tracking'}>{runningTask?.summary ?? 'Tracking'}</span>
                  </>
                ) : larkTasks.isLoading ? (
                  <><Clock size={14} /> Loading tasks...</>
                ) : !taskCatalogAvailable ? (
                  <><Clock size={14} /> {larkOffline ? 'Offline - no saved task' : 'Connect Lark first'}</>
                ) : totalOpen === 0 ? (
                  <><Clock size={14} /> No open tasks</>
                ) : (
                  <div className="hero-task-picker" ref={taskPickerRef}>
                    <span className="sr-only">Task to start</span>
                    <button
                      type="button"
                      className="hero-task-trigger no-drag"
                      onClick={() => setTaskPickerOpen((open) => !open)}
                      aria-haspopup="listbox"
                      aria-expanded={taskPickerOpen}
                    >
                      <span className="hero-task-icon" style={{ background: selectedTaskColor }}>
                        <ListTodo size={11} strokeWidth={2.3} />
                      </span>
                      <span className="hero-task-label">{selectedTask?.summary ?? 'Select task'}</span>
                      <ChevronDown className="hero-task-caret-inline" size={13} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                    {taskPickerOpen && (
                      <div className="hero-task-menu no-drag" role="dialog" aria-label="Choose task">
                        <div className="hero-task-search">
                          <Search size={14} strokeWidth={2.2} />
                          <input
                            ref={taskPickerSearchRef}
                            value={taskPickerQuery}
                            onChange={(e) => setTaskPickerQuery(e.target.value)}
                            placeholder="Search tasks"
                          />
                        </div>
                        <div className="hero-task-options" role="listbox">
                          {pickerTasks.length === 0 ? (
                            <div className="hero-task-empty">No matching tasks</div>
                          ) : (
                            pickerTasks.map((task) => {
                              const style = projectStyle(task.guid);
                              const selected = task.guid === selectedTaskValue;
                              return (
                                <button
                                  type="button"
                                  key={task.guid}
                                  className={`hero-task-option${selected ? ' selected' : ''}`}
                                  role="option"
                                  aria-selected={selected}
                                  onClick={() => {
                                    setSelectedTaskGuid(task.guid);
                                    setTaskPickerOpen(false);
                                    setTaskPickerQuery('');
                                  }}
                                >
                                  <span className="hero-task-option-icon" style={{ background: style.color }}>
                                    <ListTodo size={12} strokeWidth={2.3} />
                                  </span>
                                  <span className="hero-task-option-name">{task.summary}</span>
                                  {selected && <Check size={14} strokeWidth={2.4} />}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {running ? (
              <div className="hero-actions">
                {isPaused && (
                  <button className="hero-resume no-drag" onClick={() => resume.mutate()} disabled={resume.isPending} title="Resume tracking" aria-label="Resume tracking">
                    <Play size={18} strokeWidth={2.5} fill="currentColor" />
                  </button>
                )}
                <button className="hero-stop no-drag" onClick={() => stop.mutate()} disabled={stop.isPending} title="Stop" aria-label="Stop tracking">
                  <Square size={18} strokeWidth={2.5} fill="currentColor" />
                </button>
              </div>
            ) : (
              <div className="hero-actions">
                <button
                  className="hero-start no-drag"
                  onClick={() => selectedTask && start.mutate(selectedTask.guid)}
                  disabled={!canStartSelectedTask}
                  title={selectedTask ? `Start ${selectedTask.summary}` : 'No task available'}
                  aria-label={selectedTask ? `Start ${selectedTask.summary}` : 'No task available'}
                >
                  <Play size={18} strokeWidth={2.5} fill="currentColor" />
                </button>
              </div>
            )}
          </div>

          {recoveryNotice.data && (
            <div className="recovery-banner rise rise-1" role="status">
              <AlertTriangle size={16} strokeWidth={2.2} />
              <span>{timerRecoveryNoticeText(recoveryNotice.data, (value) => formatWorkspaceRecoveryTime(value, timeContext?.timeZone ?? null))}</span>
              <button
                className="recovery-dismiss no-drag"
                onClick={() => dismissRecovery.mutate()}
                disabled={dismissRecovery.isPending}
                title="Dismiss"
              >
                <X size={14} strokeWidth={2.4} />
              </button>
            </div>
          )}

          {entries.length > 0 && hasWorkspaceTime && (
            <>
              <div className="section-head"><span className="section-title">Today&rsquo;s activity</span></div>
              <div className="focus-card rise rise-2">
                <DayTimeline
                  entries={entries}
                  now={now}
                  runningEntryId={running?.entryId}
                  dayStart={timeContext.dayStart}
                  dayEnd={timeContext.dayEnd}
                  timeZone={timeContext.timeZone}
                />
                <Legend />
              </div>
            </>
          )}

          <div className="section-head">
            <span className="section-title">Tasks</span>
            {larkConnected && (
              <button className="btn btn-soft no-drag" onClick={() => setShowCreate((s) => !s)}>
                {showCreate ? <><X size={14} strokeWidth={2.5} /> Cancel</> : <><Plus size={14} strokeWidth={2.5} /> New task</>}
              </button>
            )}
          </div>

          {larkConnected && showCreate && <TaskComposer onCreated={onCreated} timeZone={timeContext?.timeZone ?? null} />}

          {justCreated && !showCreate && (
            <div className="create-toast rise" role="status">
              <span className="create-toast-dot" /> Created “{justCreated}” in Lark
            </div>
          )}

          {!taskCatalogAvailable ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <img className="lark-icon lark-icon--empty" src={larkIcon} alt="" />
              </span>
              <div className="h3">{larkOffline ? 'Offline with no saved tasks' : larkConfigured ? 'Connect Lark to see your tasks' : 'Lark not set up'}</div>
              <div className="callout secondary">
                {larkOffline ? 'Reconnect once to refresh your task list.' : larkConfigured ? 'Your Lark tasks become the things you track time against.' : 'Ask your workspace admin to enable the Lark integration.'}
              </div>
              {larkConfigured && !larkOffline && (
                <button className="btn btn-prominent no-drag" style={{ marginTop: 'var(--sp-4)' }} onClick={() => connectLark.mutate()} disabled={connectLark.isPending}>
                  {connectLark.isPending ? 'Opening…' : 'Connect Lark'}
                </button>
              )}
            </div>
          ) : larkTasks.isLoading ? (
            <div className="callout secondary" style={{ padding: '0 4px' }}>Loading tasks…</div>
          ) : totalOpen === 0 ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <ListTodo size={26} strokeWidth={2} />
              </span>
              <div className="h3">No open tasks</div>
              <div className="callout secondary">New Lark tasks assigned to you will show up here.</div>
            </div>
          ) : (
            <>
              {totalOpen > TASK_COLLAPSE && (
                <div className="task-search no-drag">
                  <Search size={15} strokeWidth={2} className="task-search-ico" />
                  <input className="task-search-input" type="text" placeholder={`Search ${totalOpen} tasks…`} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              )}
              <div className="task-list">
                {shownTasks.map((t) => (
                  <TaskCard
                    key={t.guid}
                    task={t}
                    now={now}
                    timeZone={timeContext?.timeZone ?? null}
                    running={!!running && running.larkTaskGuid === t.guid}
                    paused={!!running && running.larkTaskGuid === t.guid && running.paused}
                    disabled={start.isPending || stop.isPending || resume.isPending}
                    onStart={(g) => start.mutate(g)}
                    onStop={() => stop.mutate()}
                    onResume={() => resume.mutate()}
                  />
                ))}
              </div>
              {q === '' && openTasks.length > TASK_COLLAPSE && (
                <button className="btn btn-ghost btn-block no-drag" style={{ marginTop: 'var(--sp-3)' }} onClick={() => setShowAll((s) => !s)}>
                  {collapsed ? `Show all ${openTasks.length} tasks` : 'Show less'}
                </button>
              )}
              {q !== '' && openTasks.length === 0 && (
                <div className="callout secondary" style={{ padding: '4px' }}>No tasks match “{query}”.</div>
              )}
            </>
          )}

          {/* "Request time" + recent-requests list + screenshots strip are
              gone from Today. Manual time lives entirely in the Edit Time
              tab now (gap rows + inline-edit). Screenshots get their own
              dedicated surface in Reports. Today stays a focused tracker. */}
        </div>
      </div>
    </>
  );
}

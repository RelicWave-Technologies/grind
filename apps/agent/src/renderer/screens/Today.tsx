import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Square, Clock, ListTodo, Link2, Search, Plus, X } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import { sortTasks } from '../lib/taskFormat';
import DayTimeline from '../components/DayTimeline';
import TaskCard from '../components/TaskCard';
import TaskComposer from '../components/TaskComposer';
import SyncButton from '../components/SyncButton';

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
      <span><i className="dt-swatch-work" /> Work <span className="dt-leg-sub">· by task</span></span>
      <span><i className="dt-dot" style={{ background: 'var(--c-blue)' }} /> Meeting</span>
      <span><i className="dt-dot" style={{ background: 'rgba(40,36,56,0.18)' }} /> Idle</span>
    </div>
  );
}

const TASK_COLLAPSE = 8;

export default function Today() {
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => window.agent.timer.today(), refetchInterval: 3000 });
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks(), refetchInterval: 60_000 });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.agent.timer.status().then((s) => alive && setTimer(s));
    const off = window.agent.timer.onStatusChange((s) => { setTimer(s); setNow(Date.now()); });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; off(); clearInterval(tick); };
  }, []);

  const start = useMutation({
    mutationFn: (guid: string) => window.agent.timer.start(guid),
    onSuccess: (s) => {
      setTimer(s);
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
  const stop = useMutation({
    mutationFn: () => window.agent.timer.stop(),
    onSuccess: (s) => {
      setTimer(s);
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
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
  const larkConfigured = larkStatus.data?.configured !== false;

  const q = query.trim().toLowerCase();
  const filtered = tasks.filter((t) => !t.completed && (q === '' || t.summary.toLowerCase().includes(q)));
  const openTasks = sortTasks(filtered, running?.larkTaskGuid ?? null);
  const totalOpen = tasks.filter((t) => !t.completed).length;
  const collapsed = !showAll && q === '' && openTasks.length > TASK_COLLAPSE;
  const shownTasks = collapsed ? openTasks.slice(0, TASK_COLLAPSE) : openTasks;

  const heroColor = running?.larkTaskGuid ? projectStyle(running.larkTaskGuid).color : 'var(--violet)';

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Today</span>
        {larkConnected && <SyncButton />}
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          {/* Hero = live timer + stop control (no separate page) */}
          <div className={`hero-running rise rise-1${running ? ' on' : ''}`}>
            <div>
              <div className="hero-time tabular">{fmtClock(timer.workedMs)}</div>
              <div className="hero-proj">
                {running ? (
                  <><i className="dt-dot" style={{ background: heroColor }} />{runningTask?.summary ?? 'Tracking'}{running.paused ? ' · paused' : ''}</>
                ) : (
                  <><Clock size={14} /> No timer running</>
                )}
              </div>
            </div>
            {running && (
              <button className="hero-stop no-drag" onClick={() => stop.mutate()} disabled={stop.isPending} title="Stop">
                <Square size={16} strokeWidth={2.5} fill="currentColor" /> Stop
              </button>
            )}
          </div>

          {entries.length > 0 && (
            <>
              <div className="section-head"><span className="section-title">Today&rsquo;s activity</span></div>
              <div className="focus-card rise rise-2">
                <DayTimeline entries={entries} now={now} runningEntryId={running?.entryId} />
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

          {larkConnected && showCreate && <TaskComposer onCreated={onCreated} />}

          {justCreated && !showCreate && (
            <div className="create-toast rise" role="status">
              <span className="create-toast-dot" /> Created “{justCreated}” in Lark
            </div>
          )}

          {!larkConnected ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <Link2 size={26} strokeWidth={2} />
              </span>
              <div className="h3">{larkConfigured ? 'Connect Lark to see your tasks' : 'Lark not set up'}</div>
              <div className="callout secondary">
                {larkConfigured ? 'Your Lark tasks become the things you track time against.' : 'Ask your workspace admin to enable the Lark integration.'}
              </div>
              {larkConfigured && (
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
                    running={!!running && running.larkTaskGuid === t.guid}
                    disabled={start.isPending || stop.isPending}
                    onStart={(g) => start.mutate(g)}
                    onStop={() => stop.mutate()}
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

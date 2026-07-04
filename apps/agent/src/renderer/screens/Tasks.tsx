import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, X } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { sortTasks } from '../lib/taskFormat';
import larkIcon from '../assets/lark.svg';
import TaskCard from '../components/TaskCard';
import TaskComposer from '../components/TaskComposer';
import SyncButton from '../components/SyncButton';

/** Full Lark task list: open + completed, searchable, with quick create. */
export default function Tasks() {
  const qc = useQueryClient();
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks(), refetchInterval: 60_000 });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE', workedMs: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.agent.timer.status().then((s) => alive && setTimer(s));
    const off = window.agent.timer.onStatusChange((s) => { setTimer(s); setNow(Date.now()); });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; off(); clearInterval(tick); };
  }, []);

  const start = useMutation({ mutationFn: (guid: string) => window.agent.timer.start(guid), onSuccess: (s) => setTimer(s) });
  const stop = useMutation({ mutationFn: () => window.agent.timer.stop(), onSuccess: (s) => setTimer(s) });
  const resume = useMutation({ mutationFn: () => window.agent.timer.resume(), onSuccess: (s) => setTimer(s) });
  const connectLark = useMutation({ mutationFn: () => window.agent.lark.connect() });

  const onCreated = (summary: string) => {
    setShowCreate(false);
    setQuery('');
    setJustCreated(summary);
    void qc.invalidateQueries({ queryKey: ['larkTasks'] });
    window.setTimeout(() => setJustCreated(null), 5000);
  };

  const running = timer.state === 'RUNNING' ? timer : null;
  const tasks = larkTasks.data?.tasks ?? [];
  const larkConnected = !!larkStatus.data?.connected;
  const larkConfigured = larkStatus.data?.configured !== false;

  const q = query.trim().toLowerCase();
  const match = (s: string) => q === '' || s.toLowerCase().includes(q);
  const open = sortTasks(tasks.filter((t) => !t.completed && match(t.summary)), running?.larkTaskGuid ?? null);
  const done = tasks.filter((t) => t.completed && match(t.summary)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Tasks</span>
        {larkConnected && (
          <span className="toolbar-actions no-drag">
            <SyncButton />
            <button className="btn btn-soft no-drag" onClick={() => setShowCreate((s) => !s)}>
              {showCreate ? <><X size={14} strokeWidth={2.5} /> Cancel</> : <><Plus size={14} strokeWidth={2.5} /> New task</>}
            </button>
          </span>
        )}
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          {!larkConnected ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <img className="lark-icon lark-icon--empty" src={larkIcon} alt="" />
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
          ) : (
            <>
              {showCreate && <TaskComposer onCreated={onCreated} />}
              {justCreated && !showCreate && (
                <div className="create-toast rise" role="status"><span className="create-toast-dot" /> Created “{justCreated}” in Lark</div>
              )}

              {tasks.length > 6 && (
                <div className="task-search no-drag" style={{ marginTop: 'var(--sp-2)' }}>
                  <Search size={15} strokeWidth={2} className="task-search-ico" />
                  <input className="task-search-input" type="text" placeholder={`Search ${tasks.length} tasks…`} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              )}

              <div className="section-head"><span className="section-titlewrap"><span className="section-title">Open</span><span className="section-aside">{open.length}</span></span></div>
              {open.length === 0 ? (
                <div className="callout secondary" style={{ padding: '0 4px' }}>
                  {larkTasks.isLoading ? 'Loading…' : q ? 'No open tasks match.' : 'No open tasks.'}
                </div>
              ) : (
                <div className="task-list">
                  {open.map((t) => (
                    <TaskCard
                      key={t.guid}
                      task={t}
                      now={now}
                      running={!!running && running.larkTaskGuid === t.guid}
                      paused={!!running && running.larkTaskGuid === t.guid && running.paused}
                      disabled={start.isPending || stop.isPending || resume.isPending}
                      onStart={(g) => start.mutate(g)}
                      onStop={() => stop.mutate()}
                      onResume={() => resume.mutate()}
                    />
                  ))}
                </div>
              )}

              {done.length > 0 && (
                <>
                  <div className="section-head"><span className="section-titlewrap"><span className="section-title">Completed</span><span className="section-aside">{done.length}</span></span>
                    <button className="btn btn-ghost no-drag" onClick={() => setShowDone((s) => !s)}>{showDone ? 'Hide' : 'Show'}</button>
                  </div>
                  {showDone && (
                    <div className="task-list task-list-done">
                      {done.map((t) => (
                        <TaskCard key={t.guid} task={t} now={now} running={false} disabled={start.isPending || stop.isPending || resume.isPending} onStart={(g) => start.mutate(g)} onStop={() => stop.mutate()} onResume={() => resume.mutate()} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

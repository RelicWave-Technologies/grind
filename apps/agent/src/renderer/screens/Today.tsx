import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Pause, Square, Clock, ListTodo, Link2, Search, CalendarClock, Plus, X, User } from 'lucide-react';
import type { TimerStatus } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';
import DayTimeline from '../components/DayTimeline';
import ScreenshotsStrip from '../components/ScreenshotsStrip';

export function fmtClock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Compact "1h 20m" / "45m" duration. */
function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type DueInfo = { label: string; tone: 'overdue' | 'soon' | 'normal' };
function dueInfo(due: number, now: number): DueInfo {
  const day = 86_400_000;
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((startOfDay(due) - startOfDay(now)) / day);
  if (diff < 0) return { label: `Overdue ${-diff}d`, tone: 'overdue' };
  if (diff === 0) return { label: 'Due today', tone: 'soon' };
  if (diff === 1) return { label: 'Due tomorrow', tone: 'soon' };
  if (diff < 7) return { label: `Due in ${diff}d`, tone: 'normal' };
  return { label: `Due ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, tone: 'normal' };
}

const TASK_COLLAPSE = 8;

function Legend() {
  return (
    <div className="dt-legend">
      <span><i className="dt-dot" style={{ background: 'var(--violet)' }} /> Work</span>
      <span><i className="dt-dot" style={{ background: 'var(--c-blue)' }} /> Meeting</span>
      <span><i className="dt-dot" style={{ background: 'rgba(40,36,56,0.18)' }} /> Idle</span>
    </div>
  );
}

export default function Today() {
  const qc = useQueryClient();
  const today = useQuery({
    queryKey: ['today'],
    queryFn: () => window.agent.timer.today(),
    refetchInterval: 3000,
  });
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const larkTasks = useQuery({
    queryKey: ['larkTasks'],
    queryFn: () => window.agent.lark.tasks(),
    refetchInterval: 60_000,
  });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE' });
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newSummary, setNewSummary] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newDesc, setNewDesc] = useState('');

  useEffect(() => {
    let alive = true;
    void window.agent.timer.status().then((s) => alive && setTimer(s));
    const off = window.agent.timer.onStatusChange((s) => {
      setTimer(s);
      setNow(Date.now());
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(tick);
    };
  }, []);

  const start = useMutation({
    mutationFn: (guid: string) => window.agent.timer.start(null, null, guid),
    onSuccess: (s) => setTimer(s),
  });
  const stop = useMutation({
    mutationFn: () => window.agent.timer.stop(),
    onSuccess: (s) => setTimer(s),
  });
  const connectLark = useMutation({ mutationFn: () => window.agent.lark.connect() });
  const createTask = useMutation({
    mutationFn: (input: { summary: string; due?: number | null; description?: string | null }) =>
      window.agent.lark.createTask(input),
    onSuccess: (r) => {
      if (r.ok) {
        setShowCreate(false);
        setNewSummary('');
        setNewDue('');
        setNewDesc('');
        void qc.invalidateQueries({ queryKey: ['larkTasks'] });
      }
    },
  });

  const submitCreate = () => {
    const summary = newSummary.trim();
    if (!summary) return;
    const due = newDue ? new Date(`${newDue}T17:00:00`).getTime() : null;
    createTask.mutate({ summary, due, description: newDesc.trim() || null });
  };

  const running = timer.state === 'RUNNING' ? timer : null;
  const entries = today.data ?? [];
  const tasks = larkTasks.data?.tasks ?? [];
  const runningTask = running?.larkTaskGuid ? tasks.find((t) => t.guid === running.larkTaskGuid) : undefined;
  // Open tasks, filtered by search, sorted by due (soonest first) then most-tracked.
  const q = query.trim().toLowerCase();
  const openTasks = tasks
    .filter((t) => !t.completed && (q === '' || t.summary.toLowerCase().includes(q)))
    .sort((a, b) => {
      const ad = a.due ?? Infinity;
      const bd = b.due ?? Infinity;
      if (ad !== bd) return ad - bd;
      if (b.loggedMs !== a.loggedMs) return b.loggedMs - a.loggedMs;
      return a.summary.localeCompare(b.summary);
    });
  const totalOpen = tasks.filter((t) => !t.completed).length;
  const collapsed = !showAll && q === '' && openTasks.length > TASK_COLLAPSE;
  const shownTasks = collapsed ? openTasks.slice(0, TASK_COLLAPSE) : openTasks;
  const larkConnected = !!larkStatus.data?.connected;
  const larkConfigured = larkStatus.data?.configured !== false;

  if (running) {
    const color = running.larkTaskGuid ? projectStyle(running.larkTaskGuid).color : 'var(--violet)';
    return (
      <>
        <div className="toolbar drag" />
        <div className="content-scroll center-y">
          <div className="content-narrow focus rise">
            <div className="focus-head">
              <div className="focus-time">{fmtClock(running.workedMs)}</div>
              <div className="focus-proj">
                <i className="dt-dot" style={{ background: color }} />
                {runningTask?.summary ?? 'Tracking'}
              </div>
            </div>

            <div className="focus-card">
              <DayTimeline entries={entries} now={now} runningEntryId={running.entryId} />
              <Legend />
            </div>

            <div className="focus-actions">
              <div className="round-btn-label">
                <button className="round-btn" disabled title="Pause (coming soon)">
                  <Pause size={24} strokeWidth={2} fill="currentColor" />
                </button>
                <span>Pause</span>
              </div>
              <div className="round-btn-label">
                <button className="round-btn danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
                  <Square size={22} strokeWidth={2} fill="currentColor" />
                </button>
                <span>Stop</span>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Today</span>
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          <div className="hero-running rise rise-1">
            <div>
              <div className="hero-time">{fmtClock(0)}</div>
              <div className="hero-proj"><Clock size={14} /> No timer running</div>
            </div>
          </div>

          {entries.length > 0 && (
            <>
              <div className="section-head"><span className="section-title">Today&rsquo;s activity</span></div>
              <div className="focus-card rise rise-2">
                <DayTimeline entries={entries} now={now} />
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

          {/* Create-task form (creates a real Lark task) */}
          {larkConnected && showCreate && (
            <div className="create-card rise rise-1">
              <div className="create-field">
                <label className="field-label" htmlFor="nt-title">Title</label>
                <input
                  id="nt-title"
                  className="field"
                  type="text"
                  placeholder="What are you working on?"
                  value={newSummary}
                  autoFocus
                  onChange={(e) => setNewSummary(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || !newDesc)) submitCreate(); }}
                />
              </div>
              <div className="create-field">
                <label className="field-label" htmlFor="nt-desc">Description <span className="field-optional">optional</span></label>
                <textarea
                  id="nt-desc"
                  className="field create-desc"
                  placeholder="Add any details…"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
              <div className="create-row">
                <div className="create-field create-due-field">
                  <label className="field-label" htmlFor="nt-due">Due date <span className="field-optional">optional</span></label>
                  <input id="nt-due" className="field" type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} />
                </div>
                <button
                  className="btn btn-prominent btn-lg no-drag"
                  onClick={submitCreate}
                  disabled={createTask.isPending || !newSummary.trim()}
                >
                  <Plus size={15} strokeWidth={2.5} />
                  {createTask.isPending ? 'Creating…' : 'Create in Lark'}
                </button>
              </div>
              {createTask.data && !createTask.data.ok && (
                <div className="create-error"><X size={13} strokeWidth={2.5} /> Couldn’t create the task. Please try again.</div>
              )}
            </div>
          )}

          {/* Not connected / not configured → prompt to connect */}
          {!larkConnected ? (
            <div className="empty rise rise-1">
              <span className="empty-icon" style={{ background: 'var(--violet-tint)', color: 'var(--violet)' }}>
                <Link2 size={26} strokeWidth={2} />
              </span>
              <div className="h3">{larkConfigured ? 'Connect Lark to see your tasks' : 'Lark not set up'}</div>
              <div className="callout secondary">
                {larkConfigured
                  ? 'Your Lark tasks become the things you track time against.'
                  : 'Ask your workspace admin to enable the Lark integration.'}
              </div>
              {larkConfigured && (
                <button
                  className="btn btn-prominent no-drag"
                  style={{ marginTop: 'var(--sp-4)' }}
                  onClick={() => connectLark.mutate()}
                  disabled={connectLark.isPending}
                >
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
                  <input
                    className="task-search-input"
                    type="text"
                    placeholder={`Search ${totalOpen} tasks…`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
              <div className="task-list">
                {shownTasks.map((t, i) => {
                  const st = projectStyle(t.guid);
                  const due = t.due != null ? dueInfo(t.due, now) : null;
                  return (
                    <button
                      key={t.guid}
                      className={`task rise rise-${Math.min(i + 1, 3)}`}
                      onClick={() => start.mutate(t.guid)}
                      disabled={start.isPending}
                    >
                      <span className="task-icon" style={{ background: st.color }}>
                        <ListTodo size={20} strokeWidth={2} />
                      </span>
                      <span className="task-main">
                        <span className="task-title" style={{ display: 'block' }}>{t.summary}</span>
                        {(t.creatorName || t.createdAt) && (
                          <span className="task-meta">
                            <User size={11} strokeWidth={2} />
                            {[t.creatorName ? `By ${t.creatorName}` : null, t.createdAt ? fmtDate(t.createdAt) : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                        <span className="task-tags">
                          {due && (
                            <span className={`tag tag-chip due-${due.tone}`}>
                              <CalendarClock size={11} strokeWidth={2.5} /> {due.label}
                            </span>
                          )}
                          {t.loggedMs > 0 && (
                            <span className="tag tag-chip" style={{ background: 'var(--violet-tint)', color: 'var(--violet-700)' }}>
                              <Clock size={11} strokeWidth={2.5} /> {fmtDuration(t.loggedMs)}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="task-play"><Play size={15} strokeWidth={2.5} fill="currentColor" /></span>
                    </button>
                  );
                })}
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

          <ScreenshotsStrip />
        </div>
      </div>
    </>
  );
}
